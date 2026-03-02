import os
import uuid
import json
import datetime
import base64
import requests
from flask import Blueprint, request, jsonify
from ..db.database import get_db

gerrit_bp = Blueprint("gerrit", __name__, url_prefix="/api/gerrit")


# ── 헬퍼 ──────────────────────────────────────────────────────────────────────

def strip_gerrit_magic(text: str) -> str:
    """Gerrit REST API 응답의 XSSI 방지 접두어 )]}'\\n 제거."""
    magic = ")]}'\n"
    return text[len(magic):] if text.startswith(magic) else text


def _get_headers(srv: dict) -> dict:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    auth_type = srv.get("auth_type", "basic")
    token = srv.get("token", "")
    username = srv.get("username", "")
    if auth_type == "bearer" and token:
        headers["Authorization"] = f"Bearer {token}"
    elif auth_type == "basic" and username and token:
        creds = base64.b64encode(f"{username}:{token}".encode()).decode()
        headers["Authorization"] = f"Basic {creds}"
    return headers


def _all_enabled_servers() -> list[dict]:
    db = get_db()
    rows = db.execute(
        "SELECT id, name, url, username, token, auth_type, enabled FROM gerrit_servers WHERE enabled = 1 ORDER BY created_at ASC"
    ).fetchall()
    return [dict(r) for r in rows]


def _get_server(server_id: str | None) -> dict | None:
    db = get_db()
    if server_id:
        row = db.execute(
            "SELECT id, name, url, username, token, auth_type, enabled FROM gerrit_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        return dict(row) if row else None
    servers = _all_enabled_servers()
    return servers[0] if servers else None


def _fallback_env() -> dict:
    """DB에 서버가 없을 때 .env 값으로 폴백."""
    token = os.getenv("GERRIT_TOKEN", "")
    return {
        "url": os.getenv("GERRIT_URL", "http://gerrit.internal"),
        "username": "",
        "token": token,
        "auth_type": "bearer",
    }


def _resolve_server(server_id: str | None) -> dict:
    srv = _get_server(server_id)
    return srv if srv else _fallback_env()


def _gerrit_get(srv: dict, path: str, params: dict | None = None) -> requests.Response:
    return requests.get(
        f"{srv['url'].rstrip('/')}/a/{path}",
        headers=_get_headers(srv),
        params=params,
        timeout=15,
    )


# ── 서버 관리 CRUD ─────────────────────────────────────────────────────────────

@gerrit_bp.get("/servers")
def list_servers():
    """Gerrit 서버 목록 조회."""
    try:
        db = get_db()
        rows = db.execute(
            "SELECT id, name, url, username, auth_type, enabled, created_at FROM gerrit_servers ORDER BY created_at DESC"
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@gerrit_bp.post("/servers")
def register_server():
    """Gerrit 서버 등록."""
    try:
        body = request.get_json(silent=True) or {}
        name = body.get("name")
        url = body.get("url")
        username = body.get("username", "")
        token = body.get("token", "")
        auth_type = body.get("auth_type", "basic")

        if not name or not url:
            return jsonify({"error": "name and url are required"}), 400
        if auth_type not in ("basic", "bearer"):
            return jsonify({"error": "auth_type must be 'basic' or 'bearer'"}), 400

        server_id = str(uuid.uuid4())
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        db = get_db()
        db.execute(
            "INSERT INTO gerrit_servers (id, name, url, username, token, auth_type, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            (server_id, name, url, username, token, auth_type, now),
        )
        db.commit()
        row = db.execute(
            "SELECT id, name, url, username, auth_type, enabled, created_at FROM gerrit_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        return jsonify(dict(row)), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@gerrit_bp.delete("/servers/<server_id>")
def delete_server(server_id):
    """Gerrit 서버 삭제."""
    try:
        db = get_db()
        if db.execute("SELECT id FROM gerrit_servers WHERE id = ?", (server_id,)).fetchone() is None:
            return jsonify({"error": "Server not found"}), 404
        db.execute("DELETE FROM gerrit_servers WHERE id = ?", (server_id,))
        db.commit()
        return jsonify({"deleted": server_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@gerrit_bp.post("/servers/<server_id>/test")
def test_server(server_id):
    """Gerrit 서버 연결 테스트 (GET /a/accounts/self)."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT id, name, url, username, token, auth_type FROM gerrit_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        if row is None:
            return jsonify({"error": "Server not found"}), 404

        srv = dict(row)
        try:
            resp = _gerrit_get(srv, "accounts/self")
            resp.raise_for_status()
            data = json.loads(strip_gerrit_magic(resp.text))
            return jsonify({
                "status": "ok",
                "server_id": server_id,
                "user": data.get("display_name") or data.get("name") or data.get("username"),
                "email": data.get("email"),
            })
        except requests.exceptions.ConnectionError as e:
            return jsonify({"status": "error", "error": f"Connection error: {str(e)}"}), 200
        except requests.exceptions.Timeout:
            return jsonify({"status": "error", "error": "Connection timed out"}), 200
        except requests.exceptions.HTTPError as e:
            sc = e.response.status_code if e.response is not None else 500
            return jsonify({"status": "error", "error": f"HTTP {sc}: {str(e)}"}), 200
        except Exception as e:
            return jsonify({"status": "error", "error": str(e)}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── 변경사항 조회 / 검색 ───────────────────────────────────────────────────────

@gerrit_bp.get("/change/<change_id>/diff")
def get_change_diff(change_id):
    """Gerrit 변경사항 diff 조회. ?server=<id> 로 서버 지정."""
    srv = _resolve_server(request.args.get("server"))
    try:
        change_resp = _gerrit_get(srv, f"changes/{change_id}", params={
            "o": ["CURRENT_REVISION", "CURRENT_FILES", "DETAILED_LABELS", "DETAILED_ACCOUNTS"]
        })
        change_resp.raise_for_status()
        change_data = json.loads(strip_gerrit_magic(change_resp.text))

        current_revision = change_data.get("current_revision")
        files = (change_data.get("revisions", {}).get(current_revision) or {}).get("files", {})

        diffs = {}
        for filename in list(files.keys())[:20]:
            try:
                encoded = requests.utils.quote(filename, safe="")
                diff_resp = _gerrit_get(srv, f"changes/{change_id}/revisions/{current_revision}/files/{encoded}/diff",
                                        params={"intraline": True})
                if diff_resp.ok:
                    diffs[filename] = json.loads(strip_gerrit_magic(diff_resp.text))
            except Exception as fe:
                diffs[filename] = {"error": str(fe)}

        return jsonify({
            "change_id": change_id,
            "subject": change_data.get("subject"),
            "status": change_data.get("status"),
            "owner": (change_data.get("owner") or {}).get("name"),
            "branch": change_data.get("branch"),
            "project": change_data.get("project"),
            "current_revision": current_revision,
            "insertions": change_data.get("insertions", 0),
            "deletions": change_data.get("deletions", 0),
            "files": list(files.keys()),
            "diffs": diffs,
        })
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Gerrit server is unreachable"}), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Gerrit request timed out"}), 504
    except requests.exceptions.HTTPError as e:
        return jsonify({"error": f"Gerrit HTTP error {e.response.status_code if e.response else 500}"}), getattr(e.response, "status_code", 500)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@gerrit_bp.get("/change/<change_id>")
def get_change(change_id):
    """Gerrit 변경사항 기본 정보 조회. ?server=<id> 로 서버 지정."""
    srv = _resolve_server(request.args.get("server"))
    try:
        resp = _gerrit_get(srv, f"changes/{change_id}", params={
            "o": ["CURRENT_REVISION", "DETAILED_LABELS", "DETAILED_ACCOUNTS", "MESSAGES"]
        })
        resp.raise_for_status()
        return jsonify(json.loads(strip_gerrit_magic(resp.text)))
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Gerrit server is unreachable"}), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Gerrit request timed out"}), 504
    except requests.exceptions.HTTPError as e:
        return jsonify({"error": f"Gerrit HTTP error {e.response.status_code if e.response else 500}"}), getattr(e.response, "status_code", 500)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@gerrit_bp.get("/search")
def search_changes():
    """Gerrit 변경사항 검색. ?server=<id> 로 서버 지정."""
    srv = _resolve_server(request.args.get("server"))
    try:
        query = request.args.get("q", "")
        if not query:
            return jsonify({"error": "q parameter is required"}), 400
        resp = _gerrit_get(srv, "changes/", params={
            "q": query,
            "n": int(request.args.get("n", 25)),
            "S": int(request.args.get("S", 0)),
            "o": ["CURRENT_REVISION", "DETAILED_ACCOUNTS"],
        })
        resp.raise_for_status()
        return jsonify(json.loads(strip_gerrit_magic(resp.text)))
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Gerrit server is unreachable"}), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Gerrit request timed out"}), 504
    except requests.exceptions.HTTPError as e:
        return jsonify({"error": f"Gerrit HTTP error {e.response.status_code if e.response else 500}"}), getattr(e.response, "status_code", 500)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
