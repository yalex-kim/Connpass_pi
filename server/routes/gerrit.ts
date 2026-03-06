import { Router } from "express";
import db from "../db.js";

const router = Router();

interface GerritServer { id: string; name: string; url: string; username: string; token: string; auth_type: string; enabled: number }

function stripMagic(text: string): string {
  const magic = ")]}'\n";
  return text.startsWith(magic) ? text.slice(magic.length) : text;
}

function getHeaders(srv: GerritServer): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json" };
  if (srv.auth_type === "bearer" && srv.token) {
    headers["Authorization"] = `Bearer ${srv.token}`;
  } else if (srv.auth_type === "basic" && srv.username && srv.token) {
    headers["Authorization"] = `Basic ${Buffer.from(`${srv.username}:${srv.token}`).toString("base64")}`;
  }
  return headers;
}

function allEnabled(): GerritServer[] {
  return db.prepare("SELECT id, name, url, username, token, auth_type, enabled FROM gerrit_servers WHERE enabled = 1 ORDER BY created_at ASC").all() as GerritServer[];
}

function resolveServer(serverId?: string): GerritServer {
  if (serverId) {
    const row = db.prepare("SELECT id, name, url, username, token, auth_type, enabled FROM gerrit_servers WHERE id = ?").get(serverId) as GerritServer | undefined;
    if (row) return row;
  }
  const servers = allEnabled();
  if (servers.length) return servers[0];
  return {
    id: "", name: "", enabled: 1,
    url: process.env.GERRIT_URL ?? "http://gerrit.internal",
    username: "",
    token: process.env.GERRIT_TOKEN ?? "",
    auth_type: "bearer",
  };
}

async function gerritGet(srv: GerritServer, path: string, params?: Record<string, string | string[]>): Promise<Response> {
  const url = new URL(`${srv.url.replace(/\/$/, "")}/a/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) { v.forEach(val => url.searchParams.append(k, val)); }
      else url.searchParams.set(k, v);
    }
  }
  return fetch(url.toString(), { headers: getHeaders(srv), signal: AbortSignal.timeout(15000) });
}

// ── 서버 CRUD ─────────────────────────────────────────────────────────────────

router.get("/servers", (_req, res) => {
  try {
    res.json(db.prepare("SELECT id, name, url, username, auth_type, enabled, created_at FROM gerrit_servers ORDER BY created_at DESC").all());
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.post("/servers", (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body.name || !body.url) return res.status(400).json({ error: "name and url are required" });
    if (!["basic", "bearer"].includes(body.auth_type ?? "basic"))
      return res.status(400).json({ error: "auth_type must be 'basic' or 'bearer'" });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO gerrit_servers (id, name, url, username, token, auth_type, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
    ).run(id, body.name, body.url, body.username ?? "", body.token ?? "", body.auth_type ?? "basic", now);
    res.status(201).json(
      db.prepare("SELECT id, name, url, username, auth_type, enabled, created_at FROM gerrit_servers WHERE id = ?").get(id)
    );
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.delete("/servers/:id", (req, res) => {
  try {
    if (!db.prepare("SELECT id FROM gerrit_servers WHERE id = ?").get(req.params.id))
      return res.status(404).json({ error: "Server not found" });
    db.prepare("DELETE FROM gerrit_servers WHERE id = ?").run(req.params.id);
    res.json({ deleted: req.params.id });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.post("/servers/:id/test", async (req, res) => {
  try {
    const srv = db.prepare("SELECT id, name, url, username, token, auth_type FROM gerrit_servers WHERE id = ?").get(req.params.id) as GerritServer | undefined;
    if (!srv) return res.status(404).json({ error: "Server not found" });
    try {
      const resp = await gerritGet(srv, "accounts/self");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = JSON.parse(stripMagic(await resp.text())) as { display_name?: string; name?: string; username?: string; email?: string };
      res.json({ status: "ok", server_id: req.params.id, user: data.display_name ?? data.name ?? data.username, email: data.email });
    } catch (err) {
      res.json({ status: "error", error: String(err) });
    }
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── 변경사항 조회 / 검색 ───────────────────────────────────────────────────────

router.get("/change/:id/diff", async (req, res) => {
  try {
    const srv = resolveServer(req.query.server as string);
    const changeResp = await gerritGet(srv, `changes/${req.params.id}`, {
      o: ["CURRENT_REVISION", "CURRENT_FILES", "DETAILED_LABELS", "DETAILED_ACCOUNTS"],
    });
    if (!changeResp.ok) return res.status(changeResp.status).json({ error: `Gerrit HTTP error ${changeResp.status}` });
    const changeData = JSON.parse(stripMagic(await changeResp.text())) as Record<string, unknown>;
    const currentRevision = changeData["current_revision"] as string;
    const files = ((changeData["revisions"] as Record<string, unknown> ?? {})[currentRevision] as Record<string, unknown> ?? {})["files"] as Record<string, unknown> ?? {};
    const diffs: Record<string, unknown> = {};
    for (const filename of Object.keys(files).slice(0, 20)) {
      try {
        const encoded = encodeURIComponent(filename);
        const diffResp = await gerritGet(srv, `changes/${req.params.id}/revisions/${currentRevision}/files/${encoded}/diff`, { intraline: "true" });
        diffs[filename] = diffResp.ok ? JSON.parse(stripMagic(await diffResp.text())) : { error: `HTTP ${diffResp.status}` };
      } catch (fe) { diffs[filename] = { error: String(fe) }; }
    }
    res.json({
      change_id: req.params.id,
      subject: changeData["subject"], status: changeData["status"],
      owner: (changeData["owner"] as Record<string, string> | undefined)?.name,
      branch: changeData["branch"], project: changeData["project"],
      current_revision: currentRevision,
      insertions: changeData["insertions"] ?? 0, deletions: changeData["deletions"] ?? 0,
      files: Object.keys(files), diffs,
    });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.get("/change/:id", async (req, res) => {
  try {
    const srv = resolveServer(req.query.server as string);
    const resp = await gerritGet(srv, `changes/${req.params.id}`, {
      o: ["CURRENT_REVISION", "DETAILED_LABELS", "DETAILED_ACCOUNTS", "MESSAGES"],
    });
    if (!resp.ok) return res.status(resp.status).json({ error: `Gerrit HTTP error ${resp.status}` });
    res.json(JSON.parse(stripMagic(await resp.text())));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.get("/search", async (req, res) => {
  try {
    const srv = resolveServer(req.query.server as string);
    const q = (req.query.q as string) ?? "";
    if (!q) return res.status(400).json({ error: "q parameter is required" });
    const resp = await gerritGet(srv, "changes/", {
      q, n: String(parseInt(req.query.n as string) || 25),
      S: String(parseInt(req.query.S as string) || 0),
      o: ["CURRENT_REVISION", "DETAILED_ACCOUNTS"],
    });
    if (!resp.ok) return res.status(resp.status).json({ error: `Gerrit HTTP error ${resp.status}` });
    res.json(JSON.parse(stripMagic(await resp.text())));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

export default router;
