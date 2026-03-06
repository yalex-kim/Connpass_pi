import { Router } from "express";
import db from "../db.js";

const router = Router();
const MCP_PROTOCOL_VERSION = "2024-11-05";

function uid(req: import("express").Request): string {
  return (req.headers["x-user-id"] as string) ?? "default";
}

function parseHeaders(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

async function mcpPost(url: string, method: string, params: object, headers: Record<string, string>, reqId = 1) {
  const resp = await fetch(`${url.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
    }
    return {};
  }
  return resp.json();
}

// GET /api/mcp/servers
router.get("/servers", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT id, name, url, transport, enabled, created_at FROM mcp_servers WHERE user_id = ? ORDER BY created_at DESC"
    ).all(uid(req));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/mcp/servers/:id
router.get("/servers/:id", (req, res) => {
  try {
    const row = db.prepare(
      "SELECT id, name, url, transport, headers, enabled, created_at FROM mcp_servers WHERE id = ?"
    ).get(req.params.id) as (Record<string, unknown> & { headers?: string }) | undefined;
    if (!row) return res.status(404).json({ error: "Server not found" });
    if (row.headers) {
      try { row.headers = JSON.parse(row.headers as string) as unknown as string; } catch { row.headers = undefined; }
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/mcp/servers
router.post("/servers", (req, res) => {
  try {
    const body = req.body ?? {};
    const { name, url, transport = "streamable-http", headers = {} } = body;
    if (!name || !url) return res.status(400).json({ error: "name and url are required" });
    if (!["streamable-http", "sse"].includes(transport))
      return res.status(400).json({ error: "transport must be 'streamable-http' or 'sse'" });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO mcp_servers (id, user_id, name, url, transport, headers, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
    ).run(id, uid(req), name, url, transport, Object.keys(headers).length ? JSON.stringify(headers) : null, now);
    res.status(201).json(
      db.prepare("SELECT id, name, url, transport, enabled, created_at FROM mcp_servers WHERE id = ?").get(id)
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/mcp/servers/:id
router.delete("/servers/:id", (req, res) => {
  try {
    if (!db.prepare("SELECT id FROM mcp_servers WHERE id = ?").get(req.params.id))
      return res.status(404).json({ error: "Server not found" });
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(req.params.id);
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/mcp/servers/:id/test
router.post("/servers/:id/test", async (req, res) => {
  try {
    const row = db.prepare(
      "SELECT id, name, url, transport, headers FROM mcp_servers WHERE id = ?"
    ).get(req.params.id) as { id: string; name: string; url: string; transport: string; headers?: string } | undefined;
    if (!row) return res.status(404).json({ error: "Server not found" });

    const headers = parseHeaders(row.headers);
    const transport = row.transport ?? "streamable-http";

    try {
      if (transport === "streamable-http") {
        const initResp = await mcpPost(row.url, "initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "connpass-test", version: "1.0.0" },
        }, headers, 1) as { error?: unknown; result?: { tools?: unknown[] } };

        if (initResp.error) {
          return res.json({ status: "error", error: `initialize 실패: ${JSON.stringify(initResp.error)}` });
        }

        const toolsResp = await mcpPost(row.url, "tools/list", {}, headers, 2) as { error?: unknown; result?: { tools?: unknown[] } };
        const tools = toolsResp.error ? [] : (toolsResp.result?.tools ?? []);
        return res.json({ status: "ok", server_id: req.params.id, transport, tools, tool_count: (tools as unknown[]).length });
      } else {
        // SSE: 연결 가능 여부만 확인
        const resp = await fetch(`${row.url.replace(/\/$/, "")}/sse`, {
          headers: { "Accept": "text/event-stream", ...headers },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return res.json({ status: "ok", server_id: req.params.id, transport, tools: [], tool_count: 0 });
      }
    } catch (err) {
      return res.json({ status: "error", error: String(err) });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
