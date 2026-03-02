import uuid
import datetime
import json
import requests
from flask import Blueprint, request, jsonify, g
from ..db.database import get_db

mcp_bp = Blueprint("mcp", __name__, url_prefix="/api/mcp")

MCP_JSONRPC_VERSION = "2.0"
MCP_PROTOCOL_VERSION = "2024-11-05"


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(row) for row in rows]


def parse_headers(headers_value):
    if not headers_value:
        return {}
    if isinstance(headers_value, dict):
        return headers_value
    try:
        return json.loads(headers_value)
    except Exception:
        return {}


def _mcp_post(url: str, method: str, params: dict, headers: dict, req_id: int = 1):
    """streamable-http transport: POST /mcp with JSON-RPC."""
    resp = requests.post(
        f"{url.rstrip('/')}/mcp",
        json={
            "jsonrpc": MCP_JSONRPC_VERSION,
            "id": req_id,
            "method": method,
            "params": params,
        },
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **headers,
        },
        timeout=15,
    )
    resp.raise_for_status()
    # streamable-http can return SSE or plain JSON
    ct = resp.headers.get("Content-Type", "")
    if "text/event-stream" in ct:
        # Parse first data: line from SSE stream
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return {}
    return resp.json()


def _test_streamable_http(server_url: str, headers: dict):
    """streamable-http 서버 연결 테스트: initialize → tools/list."""
    init_resp = _mcp_post(server_url, "initialize", {
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "connpass-test", "version": "1.0.0"},
    }, headers, req_id=1)

    if init_resp.get("error"):
        return None, f"initialize 실패: {init_resp['error']}"

    tools_resp = _mcp_post(server_url, "tools/list", {}, headers, req_id=2)
    if tools_resp.get("error"):
        return [], None

    tools = (tools_resp.get("result") or {}).get("tools", [])
    return tools, None


def _test_sse(server_url: str, headers: dict):
    """SSE 서버 연결 테스트: GET /sse 도달 여부만 확인."""
    resp = requests.get(
        f"{server_url.rstrip('/')}/sse",
        headers={"Accept": "text/event-stream", **headers},
        stream=True,
        timeout=10,
    )
    resp.raise_for_status()
    return [], None


@mcp_bp.get("/servers")
def list_servers():
    """MCP 서버 목록 조회."""
    try:
        db = get_db()
        rows = db.execute(
            """
            SELECT id, name, url, transport, enabled, created_at
            FROM mcp_servers
            WHERE user_id = ?
            ORDER BY created_at DESC
            """,
            (g.user_id,),
        ).fetchall()
        return jsonify(rows_to_list(rows))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@mcp_bp.get("/servers/<server_id>")
def get_server(server_id):
    """MCP 서버 단일 조회."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT id, name, url, transport, headers, enabled, created_at FROM mcp_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        if row is None:
            return jsonify({"error": "Server not found"}), 404
        result = row_to_dict(row)
        if result.get("headers"):
            try:
                result["headers"] = json.loads(result["headers"])
            except Exception:
                result["headers"] = {}
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@mcp_bp.post("/servers")
def register_server():
    """MCP 서버 등록."""
    try:
        body = request.get_json(silent=True) or {}
        name = body.get("name")
        url = body.get("url")
        transport = body.get("transport", "streamable-http")
        headers = body.get("headers", {})

        if not name or not url:
            return jsonify({"error": "name and url are required"}), 400
        if transport not in ("streamable-http", "sse"):
            return jsonify({"error": "transport must be 'streamable-http' or 'sse'"}), 400

        server_id = str(uuid.uuid4())
        now = datetime.datetime.utcnow().isoformat()
        headers_json = json.dumps(headers) if headers else None

        db = get_db()
        db.execute(
            """
            INSERT INTO mcp_servers (id, user_id, name, url, transport, headers, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (server_id, g.user_id, name, url, transport, headers_json, now),
        )
        db.commit()

        row = db.execute(
            "SELECT id, name, url, transport, enabled, created_at FROM mcp_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        return jsonify(row_to_dict(row)), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@mcp_bp.delete("/servers/<server_id>")
def delete_server(server_id):
    """MCP 서버 삭제."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT id FROM mcp_servers WHERE id = ?", (server_id,)
        ).fetchone()
        if row is None:
            return jsonify({"error": "Server not found"}), 404

        db.execute("DELETE FROM mcp_servers WHERE id = ?", (server_id,))
        db.commit()
        return jsonify({"deleted": server_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@mcp_bp.post("/servers/<server_id>/test")
def test_server(server_id):
    """MCP 서버 연결 테스트 (MCP JSON-RPC 프로토콜 사용)."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT id, name, url, transport, headers FROM mcp_servers WHERE id = ?",
            (server_id,),
        ).fetchone()
        if row is None:
            return jsonify({"error": "Server not found"}), 404

        server = row_to_dict(row)
        headers = parse_headers(server.get("headers"))
        transport = server.get("transport", "streamable-http")

        try:
            if transport == "streamable-http":
                tools, err = _test_streamable_http(server["url"], headers)
            else:
                tools, err = _test_sse(server["url"], headers)

            if err:
                return jsonify({"status": "error", "error": err}), 200

            return jsonify({
                "status": "ok",
                "server_id": server_id,
                "transport": transport,
                "tools": tools,
                "tool_count": len(tools),
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
