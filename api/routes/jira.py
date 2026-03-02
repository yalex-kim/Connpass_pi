import os
import re
import uuid
import datetime
import requests
from requests.auth import HTTPBasicAuth
from flask import Blueprint, request, jsonify
from ..db.database import get_db

jira_bp = Blueprint("jira", __name__, url_prefix="/api/jira")


# ── 헬퍼 ──────────────────────────────────────────────────────────────────────

def _is_cloud_url(url: str) -> bool:
    return "atlassian.net" in url or "atlassian.com" in url


def _api_version(url: str) -> str:
    return "3" if _is_cloud_url(url) else "2"


def _api(url: str, path: str) -> str:
    return f"{url}/rest/api/{_api_version(url)}/{path}"


def _get_auth(url: str, email: str, token: str):
    if _is_cloud_url(url) and email and token:
        return HTTPBasicAuth(email, token)
    return None


def _get_headers(url: str, token: str) -> dict:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if not _is_cloud_url(url) and token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _all_enabled_servers() -> list[dict]:
    """enabled된 모든 서버를 반환 (prefixes 포함)."""
    db = get_db()
    rows = db.execute(
        "SELECT id, name, url, email, token, prefixes, enabled FROM jira_servers WHERE enabled = 1 ORDER BY created_at ASC"
    ).fetchall()
    return [dict(r) for r in rows]


def _match_prefix(prefix: str, servers: list[dict]) -> dict | None:
    """issue key prefix 또는 project명으로 서버 매핑. 대소문자 무시."""
    key = prefix.upper()
    for srv in servers:
        raw = srv.get("prefixes") or ""
        for p in raw.split(","):
            if p.strip().upper() == key:
                return srv
    return None


def _extract_issue_prefix(issue_key: str) -> str:
    """'BT-1234' → 'BT', 'WLAN-99' → 'WLAN'"""
    m = re.match(r"^([A-Z][A-Z0-9_]*)-\d+$", issue_key.upper())
    return m.group(1) if m else ""


def _extract_jql_project(jql: str) -> str:
    """JQL에서 단일 project 값 추출. 예: 'project = BT AND ...' → 'BT'"""
    m = re.search(r'\bproject\s*=\s*["\']?([A-Z][A-Z0-9_]*)["\']?', jql, re.IGNORECASE)
    return m.group(1).upper() if m else ""


def _get_server(server_id: str | None, hint: str = "") -> dict | None:
    """
    서버 결정 우선순위:
      1. server_id 명시 → 해당 서버
      2. hint(issue prefix 또는 project명) → prefix 매핑
      3. 첫 번째 enabled 서버 폴백
    """
    db = get_db()
    if server_id:
        row = db.execute(
            "SELECT id, name, url, email, token, prefixes, enabled FROM jira_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        return dict(row) if row else None

    servers = _all_enabled_servers()
    if not servers:
        return None

    if hint:
        matched = _match_prefix(hint, servers)
        if matched:
            return matched

    return servers[0]  # 폴백: 첫 번째 서버


def _fallback_env():
    """DB에 서버가 없을 때 .env 하드코딩 값으로 폴백."""
    url = os.getenv("JIRA_URL", "http://jira.internal")
    email = os.getenv("JIRA_EMAIL", "")
    token = os.getenv("JIRA_TOKEN", "")
    return {"url": url, "email": email, "token": token}


# ── 서버 관리 CRUD ─────────────────────────────────────────────────────────────

@jira_bp.get("/servers")
def list_servers():
    """Jira 서버 목록 조회."""
    try:
        db = get_db()
        rows = db.execute(
            "SELECT id, name, url, email, prefixes, enabled, created_at FROM jira_servers ORDER BY created_at DESC"
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@jira_bp.post("/servers")
def register_server():
    """Jira 서버 등록."""
    try:
        body = request.get_json(silent=True) or {}
        name = body.get("name")
        url = body.get("url")
        email = body.get("email", "")
        token = body.get("token", "")
        prefixes = body.get("prefixes", "")  # "BT,BT-TEST,WLAN"

        if not name or not url:
            return jsonify({"error": "name and url are required"}), 400

        server_id = str(uuid.uuid4())
        now = datetime.datetime.utcnow().isoformat()

        db = get_db()
        db.execute(
            "INSERT INTO jira_servers (id, name, url, email, token, prefixes, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            (server_id, name, url, email, token, prefixes, now),
        )
        db.commit()

        row = db.execute(
            "SELECT id, name, url, email, prefixes, enabled, created_at FROM jira_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        return jsonify(dict(row)), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@jira_bp.delete("/servers/<server_id>")
def delete_server(server_id):
    """Jira 서버 삭제."""
    try:
        db = get_db()
        row = db.execute("SELECT id FROM jira_servers WHERE id = ?", (server_id,)).fetchone()
        if row is None:
            return jsonify({"error": "Server not found"}), 404

        db.execute("DELETE FROM jira_servers WHERE id = ?", (server_id,))
        db.commit()
        return jsonify({"deleted": server_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@jira_bp.post("/servers/<server_id>/test")
def test_server(server_id):
    """Jira 서버 연결 테스트 (GET /rest/api/2/myself)."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT id, name, url, email, token FROM jira_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        if row is None:
            return jsonify({"error": "Server not found"}), 404

        srv = dict(row)
        try:
            resp = requests.get(
                _api(srv["url"], "myself"),
                headers=_get_headers(srv["url"], srv["token"]),
                auth=_get_auth(srv["url"], srv["email"], srv["token"]),
                timeout=10,
            )
            resp.raise_for_status()
            me = resp.json()
            return jsonify({
                "status": "ok",
                "server_id": server_id,
                "user": me.get("displayName") or me.get("name"),
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


# ── 이슈 조회 / 검색 / 댓글 ───────────────────────────────────────────────────

def _resolve_server(server_id: str | None, hint: str = ""):
    srv = _get_server(server_id, hint)
    if srv is None:
        srv = _fallback_env()
    return srv


@jira_bp.get("/issue/<issue_key>")
def get_issue(issue_key):
    """Jira 이슈 상세 조회. ?server=<id> 로 서버 지정. 미지정 시 prefix 자동 매핑."""
    hint = _extract_issue_prefix(issue_key)
    srv = _resolve_server(request.args.get("server"), hint)
    try:
        resp = requests.get(
            _api(srv["url"], f"issue/{issue_key}"),
            headers=_get_headers(srv["url"], srv["token"]),
            auth=_get_auth(srv["url"], srv["email"], srv["token"]),
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        fields = data.get("fields") or {}
        result = {
            "id": data.get("id"),
            "key": data.get("key"),
            "summary": fields.get("summary"),
            "description": fields.get("description"),
            "status": (fields.get("status") or {}).get("name"),
            "priority": (fields.get("priority") or {}).get("name"),
            "assignee": (fields.get("assignee") or {}).get("displayName"),
            "reporter": (fields.get("reporter") or {}).get("displayName"),
            "created": fields.get("created"),
            "updated": fields.get("updated"),
            "labels": fields.get("labels") or [],
            "components": [c.get("name") for c in (fields.get("components") or [])],
            "fixVersions": [v.get("name") for v in (fields.get("fixVersions") or [])],
            "raw": data,
        }
        return jsonify(result)
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Jira server is unreachable"}), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Jira request timed out"}), 504
    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code if e.response is not None else 500
        try:
            err_body = e.response.json()
        except Exception:
            err_body = {"error": str(e)}
        return jsonify(err_body), status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@jira_bp.get("/search")
def search_issues():
    """JQL로 Jira 이슈 검색. ?server=<id> 로 서버 지정. 미지정 시 JQL의 project로 자동 매핑."""
    jql = request.args.get("jql", "")
    hint = _extract_jql_project(jql)
    srv = _resolve_server(request.args.get("server"), hint)
    try:
        max_results = int(request.args.get("maxResults", 20))
        start_at = int(request.args.get("startAt", 0))

        if not jql:
            return jsonify({"error": "jql parameter is required"}), 400

        _fields = ["summary", "status", "priority", "assignee", "reporter",
                   "created", "updated", "labels", "components"]

        # Atlassian Cloud: /rest/api/3/search deprecated → POST /rest/api/3/search/jql
        if _is_cloud_url(srv["url"]):
            # 새 Cloud API: startAt 미지원, nextPageToken 방식
            cloud_body = {"jql": jql, "maxResults": max_results, "fields": _fields}
            resp = requests.post(
                _api(srv["url"], "search/jql"),
                headers=_get_headers(srv["url"], srv["token"]),
                auth=_get_auth(srv["url"], srv["email"], srv["token"]),
                json=cloud_body,
                timeout=20,
            )
        else:
            resp = requests.get(
                _api(srv["url"], "search"),
                headers=_get_headers(srv["url"], srv["token"]),
                auth=_get_auth(srv["url"], srv["email"], srv["token"]),
                params={"jql": jql, "maxResults": max_results, "startAt": start_at,
                        "fields": ",".join(_fields)},
                timeout=20,
            )
        resp.raise_for_status()
        data = resp.json()

        issues = []
        for issue in data.get("issues", []):
            fields = issue.get("fields") or {}
            issues.append({
                "id": issue.get("id"),
                "key": issue.get("key"),
                "summary": fields.get("summary"),
                "status": (fields.get("status") or {}).get("name"),
                "priority": (fields.get("priority") or {}).get("name"),
                "assignee": (fields.get("assignee") or {}).get("displayName"),
                "reporter": (fields.get("reporter") or {}).get("displayName"),
                "created": fields.get("created"),
                "updated": fields.get("updated"),
            })

        # 새 API는 total 없음 → isLast로 대체 처리
        total = data.get("total") or len(issues)
        return jsonify({
            "total": total,
            "maxResults": max_results,
            "startAt": start_at,
            "isLast": data.get("isLast", True),
            "issues": issues,
        })
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Jira server is unreachable"}), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Jira request timed out"}), 504
    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code if e.response is not None else 500
        try:
            err_body = e.response.json()
        except Exception:
            err_body = {"error": str(e)}
        return jsonify(err_body), status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@jira_bp.get("/projects")
def list_projects():
    """Jira 프로젝트 목록 조회. ?server=<id> 로 서버 지정."""
    srv = _resolve_server(request.args.get("server"))
    try:
        max_results = int(request.args.get("maxResults", 50))

        if _is_cloud_url(srv["url"]):
            # Cloud v3: /rest/api/3/project/search (페이지네이션)
            resp = requests.get(
                _api(srv["url"], "project/search"),
                headers=_get_headers(srv["url"], srv["token"]),
                auth=_get_auth(srv["url"], srv["email"], srv["token"]),
                params={"maxResults": max_results, "orderBy": "name"},
                timeout=20,
            )
        else:
            # Server v2: /rest/api/2/project (전체 목록)
            resp = requests.get(
                _api(srv["url"], "project"),
                headers=_get_headers(srv["url"], srv["token"]),
                auth=_get_auth(srv["url"], srv["email"], srv["token"]),
                timeout=20,
            )
        resp.raise_for_status()
        data = resp.json()

        # Cloud는 {"values": [...], "total": N}, Server는 [...]
        raw_list = data.get("values", data) if isinstance(data, dict) else data
        projects = [
            {
                "id": p.get("id"),
                "key": p.get("key"),
                "name": p.get("name"),
                "type": p.get("projectTypeKey"),
                "style": p.get("style"),
                "lead": (p.get("lead") or {}).get("displayName"),
            }
            for p in raw_list
        ]
        total = data.get("total", len(projects)) if isinstance(data, dict) else len(projects)
        return jsonify({"total": total, "projects": projects})
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Jira server is unreachable"}), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Jira request timed out"}), 504
    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code if e.response is not None else 500
        try:
            err_body = e.response.json()
        except Exception:
            err_body = {"error": str(e)}
        return jsonify(err_body), status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@jira_bp.post("/issue/<issue_key>/comment")
def add_comment(issue_key):
    """Jira 이슈에 댓글 추가. ?server=<id> 로 서버 지정. 미지정 시 prefix 자동 매핑."""
    hint = _extract_issue_prefix(issue_key)
    srv = _resolve_server(request.args.get("server"), hint)
    try:
        body = request.get_json(silent=True) or {}
        comment_body = body.get("body")

        if not comment_body:
            return jsonify({"error": "body is required"}), 400

        resp = requests.post(
            _api(srv["url"], f"issue/{issue_key}/comment"),
            headers=_get_headers(srv["url"], srv["token"]),
            auth=_get_auth(srv["url"], srv["email"], srv["token"]),
            json={"body": comment_body},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        return jsonify({
            "id": data.get("id"),
            "author": data.get("author", {}).get("displayName"),
            "body": data.get("body"),
            "created": data.get("created"),
        }), 201
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Jira server is unreachable"}), 503
    except requests.exceptions.Timeout:
        return jsonify({"error": "Jira request timed out"}), 504
    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code if e.response is not None else 500
        try:
            err_body = e.response.json()
        except Exception:
            err_body = {"error": str(e)}
        return jsonify(err_body), status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500
