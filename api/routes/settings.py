import json
import os
import concurrent.futures
import requests as http_requests
from flask import Blueprint, request, jsonify, g
from ..db.database import get_db

settings_bp = Blueprint("settings", __name__, url_prefix="/api/settings")


def row_to_dict(row):
    return dict(row) if row else None


def parse_ui_settings(value):
    """ui_settings JSON 문자열을 dict로 변환."""
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value)
    except Exception:
        return {}


@settings_bp.get("")
def get_settings():
    """사용자 설정 조회."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT * FROM user_settings WHERE user_id = ?",
            (g.user_id,),
        ).fetchone()

        if row is None:
            # 기본값으로 초기화
            db.execute(
                """
                INSERT INTO user_settings (user_id, default_model, translate_model, translate_lang)
                VALUES (?, 'GLM4.7', 'GLM4.7', 'ko')
                """,
                (g.user_id,),
            )
            db.commit()
            row = db.execute(
                "SELECT * FROM user_settings WHERE user_id = ?",
                (g.user_id,),
            ).fetchone()

        result = row_to_dict(row)
        result["ui_settings"] = parse_ui_settings(result.get("ui_settings"))
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.get("/agentmd")
def get_agentmd():
    """Agent.md 조회."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT agent_md FROM user_settings WHERE user_id = ?",
            (g.user_id,),
        ).fetchone()
        content = row["agent_md"] if row and row["agent_md"] else ""
        return jsonify({"content": content})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.post("/agentmd")
def save_agentmd():
    """Agent.md 저장."""
    try:
        body = request.get_json(silent=True) or {}
        content = body.get("content", "")
        db = get_db()
        db.execute(
            "INSERT INTO user_settings (user_id, default_model, translate_model, translate_lang, agent_md) VALUES (?, 'GLM4.7', 'GLM4.7', 'ko', ?) ON CONFLICT(user_id) DO UPDATE SET agent_md = excluded.agent_md",
            (g.user_id, content),
        )
        db.commit()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.get("/model")
def get_model_settings():
    """LLM 모델 설정 조회."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT default_model, ui_settings FROM user_settings WHERE user_id = ?",
            (g.user_id,),
        ).fetchone()
        if row is None:
            return jsonify({"model": "GLM4.7", "temperature": 0.7, "maxTokens": 4096, "maxToolSteps": 10, "thinkingMode": "off"})
        ui = parse_ui_settings(row["ui_settings"])
        return jsonify({
            "model": row["default_model"] or "GLM4.7",
            "temperature": ui.get("temperature", 0.7),
            "maxTokens": ui.get("maxTokens", 4096),
            "maxToolSteps": ui.get("maxToolSteps", 10),
            "thinkingMode": ui.get("thinkingMode", "off"),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.post("/model")
def save_model_settings():
    """LLM 모델 설정 저장."""
    try:
        body = request.get_json(silent=True) or {}
        db = get_db()
        row = db.execute(
            "SELECT ui_settings FROM user_settings WHERE user_id = ?",
            (g.user_id,),
        ).fetchone()
        if row is None:
            db.execute(
                "INSERT INTO user_settings (user_id, default_model, translate_model, translate_lang) VALUES (?, 'GLM4.7', 'GLM4.7', 'ko')",
                (g.user_id,),
            )
            db.commit()
            row = db.execute("SELECT ui_settings FROM user_settings WHERE user_id = ?", (g.user_id,)).fetchone()

        ui = parse_ui_settings(row["ui_settings"])
        for key in ("temperature", "maxTokens", "maxToolSteps", "thinkingMode"):
            if key in body:
                ui[key] = body[key]

        updates = ["ui_settings = ?"]
        values = [json.dumps(ui, ensure_ascii=False)]
        if "model" in body:
            updates.append("default_model = ?")
            values.append(body["model"])
        values.append(g.user_id)

        db.execute(f"UPDATE user_settings SET {', '.join(updates)} WHERE user_id = ?", values)
        db.commit()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.get("/llm-configs")
def get_llm_configs():
    """모델별 서버/파라미터 설정 전체 조회."""
    try:
        db = get_db()
        rows = db.execute(
            "SELECT * FROM llm_model_configs WHERE is_builtin = 1 OR user_id = ? ORDER BY is_builtin DESC, model_id",
            (g.user_id,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.get("/llm-configs/<path:model_id>")
def get_llm_config(model_id):
    """특정 모델의 서버/파라미터 설정 조회."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT * FROM llm_model_configs WHERE model_id = ?", (model_id,)
        ).fetchone()
        if row is None:
            return jsonify({
                "model_id": model_id,
                "display_name": model_id,
                "base_url": "http://vllm.internal/v1",
                "api_key": "",
                "temperature": 0.7,
                "max_tokens": 4096,
                "context_window": 128000,
                "is_builtin": 0,
            })
        return jsonify(dict(row))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.post("/llm-configs")
def create_llm_config():
    """사용자 정의 모델 추가."""
    try:
        body = request.get_json(silent=True) or {}
        model_id = body.get("model_id", "").strip()
        if not model_id:
            return jsonify({"error": "model_id is required"}), 400
        db = get_db()
        # 이미 존재하는 경우 덮어쓰기 금지 (PUT으로만 업데이트)
        if db.execute("SELECT model_id FROM llm_model_configs WHERE model_id = ?", (model_id,)).fetchone():
            return jsonify({"error": f"Model '{model_id}' already exists. Use PUT to update."}), 409
        db.execute(
            """
            INSERT INTO llm_model_configs
                (model_id, display_name, base_url, api_key, temperature, max_tokens, context_window, is_builtin, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                model_id,
                body.get("display_name", model_id),
                body.get("base_url", "http://vllm.internal/v1"),
                body.get("api_key", ""),
                body.get("temperature", 0.7),
                body.get("max_tokens", 4096),
                body.get("context_window", 128000),
                g.user_id,
            ),
        )
        db.commit()
        row = db.execute(
            "SELECT * FROM llm_model_configs WHERE model_id = ?", (model_id,)
        ).fetchone()
        return jsonify(dict(row)), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.put("/llm-configs/<path:model_id>")
def save_llm_config(model_id):
    """특정 모델의 서버/파라미터 설정 저장."""
    try:
        body = request.get_json(silent=True) or {}
        db = get_db()
        db.execute(
            """
            INSERT INTO llm_model_configs
                (model_id, display_name, base_url, api_key, temperature, max_tokens, context_window, is_builtin)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(model_id) DO UPDATE SET
                display_name   = excluded.display_name,
                base_url       = excluded.base_url,
                api_key        = excluded.api_key,
                temperature    = excluded.temperature,
                max_tokens     = excluded.max_tokens,
                context_window = excluded.context_window
            """,
            (
                model_id,
                body.get("display_name", model_id),
                body.get("base_url", "http://vllm.internal/v1"),
                body.get("api_key", ""),
                body.get("temperature", 0.7),
                body.get("max_tokens", 4096),
                body.get("context_window", 128000),
            ),
        )
        db.commit()
        row = db.execute(
            "SELECT * FROM llm_model_configs WHERE model_id = ?", (model_id,)
        ).fetchone()
        return jsonify(dict(row))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.delete("/llm-configs/<path:model_id>")
def delete_llm_config(model_id):
    """사용자 정의 모델 삭제 (기본 제공 모델은 삭제 불가)."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT is_builtin FROM llm_model_configs WHERE model_id = ? AND (is_builtin = 1 OR user_id = ?)",
            (model_id, g.user_id),
        ).fetchone()
        if row is None:
            return jsonify({"error": "Model not found"}), 404
        if row["is_builtin"]:
            return jsonify({"error": "Built-in models cannot be deleted"}), 403
        db.execute("DELETE FROM llm_model_configs WHERE model_id = ? AND user_id = ? AND is_builtin = 0", (model_id, g.user_id))
        db.commit()
        return jsonify({"deleted": model_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.get("/llm-configs/vllm-models")
def fetch_vllm_models():
    """지정된 vLLM 서버에서 사용 가능한 모델 목록을 조회한다."""
    try:
        base_url = request.args.get("base_url", "").strip().rstrip("/")
        api_key = request.args.get("api_key", "")
        if not base_url:
            return jsonify({"error": "base_url is required"}), 400

        headers = {"Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        resp = http_requests.get(f"{base_url}/models", headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        models = [m.get("id", "") for m in data.get("data", []) if m.get("id")]
        return jsonify({"models": models, "base_url": base_url})
    except http_requests.exceptions.ConnectionError:
        return jsonify({"error": "Cannot connect to vLLM server"}), 503
    except http_requests.exceptions.Timeout:
        return jsonify({"error": "Connection timed out"}), 504
    except http_requests.exceptions.HTTPError as e:
        sc = e.response.status_code if e.response is not None else 500
        return jsonify({"error": f"HTTP {sc}"}), sc
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.get("/model-health")
def get_model_health():
    """각 LLM 모델의 헬스체크 — base_url/models 접근 가능 여부를 병렬 확인."""
    try:
        db = get_db()
        rows = db.execute(
            "SELECT model_id, base_url, api_key FROM llm_model_configs WHERE is_builtin = 1 OR user_id = ?",
            (g.user_id,),
        ).fetchall()

        def check_model(row):
            model_id = row["model_id"]
            base_url = (row["base_url"] or "").rstrip("/")
            api_key = row["api_key"] or ""
            if not base_url:
                return model_id, False
            # OpenAI 모델은 OPENAI_API_KEY 환경변수 우선
            if "openai.com" in base_url or model_id.startswith("gpt-"):
                api_key = os.getenv("OPENAI_API_KEY", api_key)
            headers = {"Accept": "application/json"}
            if api_key and api_key != "none":
                headers["Authorization"] = f"Bearer {api_key}"
            try:
                resp = http_requests.get(f"{base_url}/models", headers=headers, timeout=3)
                return model_id, resp.status_code < 500
            except Exception:
                return model_id, False

        health = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            futures = {executor.submit(check_model, row): row["model_id"] for row in rows}
            done, _ = concurrent.futures.wait(futures, timeout=5)
            for future in done:
                try:
                    model_id, online = future.result()
                    health[model_id] = online
                except Exception:
                    pass
            # timeout된 것들은 offline 처리
            for future, model_id in futures.items():
                if model_id not in health:
                    health[model_id] = False
        return jsonify(health)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@settings_bp.put("")
def update_settings():
    """사용자 설정 저장."""
    try:
        body = request.get_json(silent=True) or {}
        db = get_db()

        # 현재 설정 존재 여부 확인
        row = db.execute(
            "SELECT user_id FROM user_settings WHERE user_id = ?",
            (g.user_id,),
        ).fetchone()

        allowed_fields = [
            "agent_md",
            "default_model",
            "translate_model",
            "translate_lang",
            "translate_prompt",
        ]

        if row is None:
            # 신규 삽입
            db.execute(
                """
                INSERT INTO user_settings (user_id, default_model, translate_model, translate_lang)
                VALUES (?, 'GLM4.7', 'GLM4.7', 'ko')
                """,
                (g.user_id,),
            )
            db.commit()

        updates = []
        values = []

        for field in allowed_fields:
            if field in body:
                updates.append(f"{field} = ?")
                values.append(body[field])

        # ui_settings는 JSON 직렬화
        if "ui_settings" in body:
            updates.append("ui_settings = ?")
            ui_val = body["ui_settings"]
            if isinstance(ui_val, dict):
                values.append(json.dumps(ui_val, ensure_ascii=False))
            else:
                values.append(ui_val)

        if not updates:
            return jsonify({"error": "No fields to update"}), 400

        values.append(g.user_id)
        db.execute(
            f"UPDATE user_settings SET {', '.join(updates)} WHERE user_id = ?",
            values,
        )
        db.commit()

        updated = db.execute(
            "SELECT * FROM user_settings WHERE user_id = ?",
            (g.user_id,),
        ).fetchone()
        result = row_to_dict(updated)
        result["ui_settings"] = parse_ui_settings(result.get("ui_settings"))
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
