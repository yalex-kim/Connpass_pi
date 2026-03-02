import uuid
import datetime
import os
import requests
from flask import Blueprint, request, jsonify, g
from ..db.database import get_db

sessions_bp = Blueprint("sessions", __name__, url_prefix="/api")

VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "http://vllm.internal/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# OpenAI 모델명 → 사외 테스트용 모델 식별
OPENAI_MODELS = {"gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"}


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(row) for row in rows]


def _chat_completions(base_url: str, api_key: str, model: str, messages: list, max_tokens: int = 30) -> str:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    resp = requests.post(
        f"{base_url}/chat/completions",
        headers=headers,
        json={"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0.3},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


def generate_title(message: str, model: str) -> str:
    messages = [
        {"role": "system", "content": "다음 메시지를 보고 5단어 이내 한국어 채팅 제목을 만들어라. 제목만 출력하라."},
        {"role": "user", "content": message[:500]},
    ]
    # OpenAI 모델이거나 OPENAI_API_KEY가 있으면 OpenAI 사용
    if model in OPENAI_MODELS or (OPENAI_API_KEY and VLLM_BASE_URL == "http://vllm.internal/v1"):
        title_model = model if model in OPENAI_MODELS else "gpt-4o-mini"
        try:
            return _chat_completions("https://api.openai.com/v1", OPENAI_API_KEY, title_model, messages)
        except Exception:
            pass
    # 사내 vLLM 시도
    try:
        return _chat_completions(VLLM_BASE_URL, "", model, messages)
    except Exception:
        return message[:30]


@sessions_bp.get("/sessions")
def list_sessions():
    """최근 순 세션 목록 반환."""
    try:
        db = get_db()
        rows = db.execute(
            """
            SELECT id, title, persona, model, created_at, updated_at
            FROM sessions
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT 100
            """,
            (g.user_id,),
        ).fetchall()
        return jsonify(rows_to_list(rows))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@sessions_bp.post("/sessions")
def create_session():
    """새 세션 생성."""
    try:
        body = request.get_json(silent=True) or {}
        session_id = str(uuid.uuid4())
        now = datetime.datetime.utcnow().isoformat()
        title = body.get("title", "새 대화")
        persona = body.get("persona")
        model = body.get("model", "GLM4.7")

        db = get_db()
        db.execute(
            """
            INSERT INTO sessions (id, user_id, title, persona, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (session_id, g.user_id, title, persona, model, now, now),
        )
        db.commit()

        row = db.execute(
            "SELECT id, title, persona, model, created_at, updated_at FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        return jsonify(row_to_dict(row)), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@sessions_bp.get("/sessions/<session_id>")
def get_session(session_id):
    """세션 정보 + 메시지 이력 반환."""
    try:
        db = get_db()
        session = db.execute(
            "SELECT id, title, persona, model, created_at, updated_at FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()

        if session is None:
            return jsonify({"error": "Session not found"}), 404

        messages = db.execute(
            "SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC",
            (session_id,),
        ).fetchall()

        result = row_to_dict(session)
        result["messages"] = rows_to_list(messages)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@sessions_bp.delete("/sessions/<session_id>")
def delete_session(session_id):
    """세션 삭제 (메시지 포함, CASCADE)."""
    try:
        db = get_db()
        row = db.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            return jsonify({"error": "Session not found"}), 404

        db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        db.commit()
        return jsonify({"deleted": session_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@sessions_bp.patch("/sessions/<session_id>")
def update_session(session_id):
    """세션 title 업데이트."""
    try:
        body = request.get_json(silent=True) or {}
        db = get_db()

        row = db.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            return jsonify({"error": "Session not found"}), 404

        now = datetime.datetime.utcnow().isoformat()
        updates = []
        values = []

        if "title" in body:
            updates.append("title = ?")
            values.append(body["title"])
        if "persona" in body:
            updates.append("persona = ?")
            values.append(body["persona"])
        if "model" in body:
            updates.append("model = ?")
            values.append(body["model"])

        if not updates:
            return jsonify({"error": "No fields to update"}), 400

        updates.append("updated_at = ?")
        values.append(now)
        values.append(session_id)

        db.execute(
            f"UPDATE sessions SET {', '.join(updates)} WHERE id = ?",
            values,
        )
        db.commit()

        updated = db.execute(
            "SELECT id, title, persona, model, created_at, updated_at FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        return jsonify(row_to_dict(updated))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@sessions_bp.post("/sessions/<session_id>/messages")
def append_message(session_id):
    """메시지 추가."""
    try:
        body = request.get_json(silent=True) or {}
        role = body.get("role")
        content = body.get("content")

        if not role or content is None:
            return jsonify({"error": "role and content are required"}), 400

        if role not in ("system", "user", "assistant", "tool"):
            return jsonify({"error": "Invalid role"}), 400

        db = get_db()
        session = db.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if session is None:
            return jsonify({"error": "Session not found"}), 404

        msg_id = str(uuid.uuid4())
        now = datetime.datetime.utcnow().isoformat()

        db.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (msg_id, session_id, role, content, now),
        )
        db.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        db.commit()

        msg = db.execute(
            "SELECT id, session_id, role, content, created_at FROM messages WHERE id = ?",
            (msg_id,),
        ).fetchone()
        return jsonify(row_to_dict(msg)), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@sessions_bp.post("/sessions/generate-title")
def generate_title_endpoint():
    """LLM으로 5단어 이내 세션 제목 생성."""
    try:
        body = request.get_json(silent=True) or {}
        message = body.get("message", "")
        model = body.get("model", "GLM4.7")

        if not message:
            return jsonify({"error": "message is required"}), 400

        title = generate_title(message, model)
        return jsonify({"title": title})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@sessions_bp.post("/sessions/<session_id>/upload")
def upload_file(session_id):
    """파일 업로드 스텁 (Phase 8용)."""
    try:
        db = get_db()
        session = db.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if session is None:
            return jsonify({"error": "Session not found"}), 404

        if "file" not in request.files:
            return jsonify({"error": "No file provided"}), 400

        file = request.files["file"]
        filename = file.filename or "unnamed"

        # Phase 8: 실제 파일 파싱 및 임베딩 처리 예정
        # 현재는 스텁으로 파일명만 반환
        return jsonify({
            "status": "stub",
            "session_id": session_id,
            "filename": filename,
            "message": "File upload will be fully implemented in Phase 8",
        }), 202
    except Exception as e:
        return jsonify({"error": str(e)}), 500
