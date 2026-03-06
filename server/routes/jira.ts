import { Router } from "express";
import db from "../db.js";

const router = Router();

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────

function isCloud(url: string) { return url.includes("atlassian.net") || url.includes("atlassian.com"); }
function apiVersion(url: string) { return isCloud(url) ? "3" : "2"; }
function apiUrl(url: string, path: string) { return `${url}/rest/api/${apiVersion(url)}/${path}`; }

function getHeaders(url: string, token: string, email?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json" };
  if (isCloud(url) && email && token) {
    headers["Authorization"] = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  } else if (!isCloud(url) && token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

interface JiraServer { id: string; name: string; url: string; email: string; token: string; prefixes: string; enabled: number }

function allEnabled(): JiraServer[] {
  return db.prepare("SELECT id, name, url, email, token, prefixes, enabled FROM jira_servers WHERE enabled = 1 ORDER BY created_at ASC").all() as JiraServer[];
}

function matchPrefix(prefix: string, servers: JiraServer[]): JiraServer | undefined {
  const key = prefix.toUpperCase();
  return servers.find(s => (s.prefixes ?? "").split(",").some(p => p.trim().toUpperCase() === key));
}

function extractPrefix(issueKey: string): string {
  const m = issueKey.toUpperCase().match(/^([A-Z][A-Z0-9_]*)-\d+$/);
  return m ? m[1] : "";
}

function extractJqlProject(jql: string): string {
  const m = jql.match(/\bproject\s*=\s*["']?([A-Z][A-Z0-9_]*)["']?/i);
  return m ? m[1].toUpperCase() : "";
}

function getServer(serverId?: string, hint = ""): JiraServer | undefined {
  if (serverId) {
    return db.prepare("SELECT id, name, url, email, token, prefixes, enabled FROM jira_servers WHERE id = ?").get(serverId) as JiraServer | undefined;
  }
  const servers = allEnabled();
  if (!servers.length) return undefined;
  if (hint) { const matched = matchPrefix(hint, servers); if (matched) return matched; }
  return servers[0];
}

function resolveServer(serverId?: string, hint = ""): JiraServer {
  const srv = getServer(serverId, hint);
  if (srv) return srv;
  return {
    id: "", name: "", enabled: 1, prefixes: "",
    url: process.env.JIRA_URL ?? "http://jira.internal",
    email: process.env.JIRA_EMAIL ?? "",
    token: process.env.JIRA_TOKEN ?? "",
  };
}

// ── 서버 CRUD ─────────────────────────────────────────────────────────────────

router.get("/servers", (_req, res) => {
  try {
    res.json(db.prepare("SELECT id, name, url, email, prefixes, enabled, created_at FROM jira_servers ORDER BY created_at DESC").all());
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.post("/servers", (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body.name || !body.url) return res.status(400).json({ error: "name and url are required" });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO jira_servers (id, name, url, email, token, prefixes, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
    ).run(id, body.name, body.url, body.email ?? "", body.token ?? "", body.prefixes ?? "", now);
    res.status(201).json(
      db.prepare("SELECT id, name, url, email, prefixes, enabled, created_at FROM jira_servers WHERE id = ?").get(id)
    );
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.delete("/servers/:id", (req, res) => {
  try {
    if (!db.prepare("SELECT id FROM jira_servers WHERE id = ?").get(req.params.id))
      return res.status(404).json({ error: "Server not found" });
    db.prepare("DELETE FROM jira_servers WHERE id = ?").run(req.params.id);
    res.json({ deleted: req.params.id });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.post("/servers/:id/test", async (req, res) => {
  try {
    const srv = db.prepare("SELECT id, name, url, email, token FROM jira_servers WHERE id = ?").get(req.params.id) as JiraServer | undefined;
    if (!srv) return res.status(404).json({ error: "Server not found" });
    try {
      const resp = await fetch(apiUrl(srv.url, "myself"), {
        headers: getHeaders(srv.url, srv.token, srv.email),
        signal: AbortSignal.timeout(10000),
      });
      resp.raise_for_status?.();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const me = await resp.json() as { displayName?: string; name?: string };
      res.json({ status: "ok", server_id: req.params.id, user: me.displayName ?? me.name });
    } catch (err) {
      res.json({ status: "error", error: String(err) });
    }
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ── 이슈 조회 / 검색 ──────────────────────────────────────────────────────────

router.get("/issue/:key", async (req, res) => {
  try {
    const srv = resolveServer(req.query.server as string, extractPrefix(req.params.key));
    const resp = await fetch(apiUrl(srv.url, `issue/${req.params.key}`), {
      headers: getHeaders(srv.url, srv.token, srv.email),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return res.status(resp.status).json(await resp.json());
    const data = await resp.json() as { id?: string; key?: string; fields?: Record<string, unknown> };
    const f = data.fields ?? {};
    res.json({
      id: data.id, key: data.key,
      summary: f["summary"],
      description: f["description"],
      status: (f["status"] as Record<string, string> | undefined)?.name,
      priority: (f["priority"] as Record<string, string> | undefined)?.name,
      assignee: (f["assignee"] as Record<string, string> | undefined)?.displayName,
      reporter: (f["reporter"] as Record<string, string> | undefined)?.displayName,
      created: f["created"], updated: f["updated"],
      labels: f["labels"] ?? [],
      components: ((f["components"] as Array<{ name: string }>) ?? []).map(c => c.name),
      fixVersions: ((f["fixVersions"] as Array<{ name: string }>) ?? []).map(v => v.name),
      raw: data,
    });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.get("/search", async (req, res) => {
  try {
    const jql = (req.query.jql as string) ?? "";
    if (!jql) return res.status(400).json({ error: "jql parameter is required" });
    const srv = resolveServer(req.query.server as string, extractJqlProject(jql));
    const maxResults = parseInt(req.query.maxResults as string) || 20;
    const startAt = parseInt(req.query.startAt as string) || 0;
    const fields = ["summary", "status", "priority", "assignee", "reporter", "created", "updated", "labels", "components"];

    let resp: Response;
    if (isCloud(srv.url)) {
      resp = await fetch(apiUrl(srv.url, "search/jql"), {
        method: "POST",
        headers: getHeaders(srv.url, srv.token, srv.email),
        body: JSON.stringify({ jql, maxResults, fields }),
        signal: AbortSignal.timeout(20000),
      });
    } else {
      const params = new URLSearchParams({ jql, maxResults: String(maxResults), startAt: String(startAt), fields: fields.join(",") });
      resp = await fetch(`${apiUrl(srv.url, "search")}?${params}`, {
        headers: getHeaders(srv.url, srv.token, srv.email),
        signal: AbortSignal.timeout(20000),
      });
    }
    if (!resp.ok) return res.status(resp.status).json(await resp.json());
    const data = await resp.json() as { issues?: Array<Record<string, unknown>>; total?: number; isLast?: boolean };
    const issues = (data.issues ?? []).map((issue) => {
      const f = (issue.fields ?? {}) as Record<string, unknown>;
      return {
        id: issue.id, key: issue.key,
        summary: f["summary"],
        status: (f["status"] as Record<string, string> | undefined)?.name,
        priority: (f["priority"] as Record<string, string> | undefined)?.name,
        assignee: (f["assignee"] as Record<string, string> | undefined)?.displayName,
        reporter: (f["reporter"] as Record<string, string> | undefined)?.displayName,
        created: f["created"], updated: f["updated"],
      };
    });
    res.json({ total: data.total ?? issues.length, maxResults, startAt, isLast: data.isLast ?? true, issues });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.get("/projects", async (req, res) => {
  try {
    const srv = resolveServer(req.query.server as string);
    const maxResults = parseInt(req.query.maxResults as string) || 50;
    let resp: Response;
    if (isCloud(srv.url)) {
      const params = new URLSearchParams({ maxResults: String(maxResults), orderBy: "name" });
      resp = await fetch(`${apiUrl(srv.url, "project/search")}?${params}`, {
        headers: getHeaders(srv.url, srv.token, srv.email), signal: AbortSignal.timeout(20000),
      });
    } else {
      resp = await fetch(apiUrl(srv.url, "project"), {
        headers: getHeaders(srv.url, srv.token, srv.email), signal: AbortSignal.timeout(20000),
      });
    }
    if (!resp.ok) return res.status(resp.status).json(await resp.json());
    const data = await resp.json() as Record<string, unknown> | unknown[];
    const rawList: unknown[] = Array.isArray(data) ? data : ((data as Record<string, unknown>)["values"] as unknown[] ?? []);
    const projects = (rawList as Array<Record<string, unknown>>).map(p => ({
      id: p["id"], key: p["key"], name: p["name"], type: p["projectTypeKey"], style: p["style"],
      lead: (p["lead"] as Record<string, string> | undefined)?.displayName,
    }));
    const total = Array.isArray(data) ? projects.length : ((data as Record<string, unknown>)["total"] as number ?? projects.length);
    res.json({ total, projects });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

router.post("/issue/:key/comment", async (req, res) => {
  try {
    const srv = resolveServer(req.query.server as string, extractPrefix(req.params.key));
    const body = req.body ?? {};
    if (!body.body) return res.status(400).json({ error: "body is required" });
    const resp = await fetch(apiUrl(srv.url, `issue/${req.params.key}/comment`), {
      method: "POST",
      headers: getHeaders(srv.url, srv.token, srv.email),
      body: JSON.stringify({ body: body.body }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return res.status(resp.status).json(await resp.json());
    const data = await resp.json() as { id?: string; author?: Record<string, string>; body?: unknown; created?: string };
    res.status(201).json({ id: data.id, author: data.author?.displayName, body: data.body, created: data.created });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

export default router;
