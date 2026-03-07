import { Router } from "express";
import db from "../db.js";
import { invalidateModelCache } from "../models.js";

const router = Router();

function uid(req: import("express").Request): string {
  return (req.headers["x-user-id"] as string) ?? "default";
}

function ensureUser(userId: string) {
  const exists = db.prepare("SELECT user_id FROM user_settings WHERE user_id = ?").get(userId);
  if (!exists) {
    db.prepare(
      "INSERT INTO user_settings (user_id, default_model, translate_model, translate_lang) VALUES (?, 'GLM4.7', 'GLM4.7', 'ko')"
    ).run(userId);
  }
}

function parseUiSettings(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

// GET /api/settings
router.get("", (req, res) => {
  try {
    ensureUser(uid(req));
    const row = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(uid(req)) as Record<string, unknown>;
    row["ui_settings"] = parseUiSettings(row["ui_settings"] as string);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/settings
router.put("", (req, res) => {
  try {
    ensureUser(uid(req));
    const body = req.body ?? {};
    const allowed = ["agent_md", "default_model", "translate_model", "translate_lang", "translate_prompt"];
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const f of allowed) {
      if (f in body) { fields.push(`${f} = ?`); values.push(body[f]); }
    }
    if ("ui_settings" in body) {
      fields.push("ui_settings = ?");
      values.push(typeof body.ui_settings === "object" ? JSON.stringify(body.ui_settings) : body.ui_settings);
    }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    values.push(uid(req));
    db.prepare(`UPDATE user_settings SET ${fields.join(", ")} WHERE user_id = ?`).run(...values);
    const row = db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(uid(req)) as Record<string, unknown>;
    row["ui_settings"] = parseUiSettings(row["ui_settings"] as string);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/settings/agentmd
router.get("/agentmd", (req, res) => {
  try {
    const row = db.prepare("SELECT agent_md FROM user_settings WHERE user_id = ?").get(uid(req)) as { agent_md?: string } | undefined;
    res.json({ content: row?.agent_md ?? "" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/settings/agentmd
router.post("/agentmd", (req, res) => {
  try {
    const { content = "" } = req.body ?? {};
    db.prepare(
      "INSERT INTO user_settings (user_id, default_model, translate_model, translate_lang, agent_md) VALUES (?, 'GLM4.7', 'GLM4.7', 'ko', ?) ON CONFLICT(user_id) DO UPDATE SET agent_md = excluded.agent_md"
    ).run(uid(req), content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/settings/model
router.get("/model", (req, res) => {
  try {
    const row = db.prepare("SELECT default_model, ui_settings FROM user_settings WHERE user_id = ?").get(uid(req)) as { default_model?: string; ui_settings?: string } | undefined;
    if (!row) return res.json({ model: "GLM4.7", temperature: 0.7, maxTokens: 4096, maxToolSteps: 10, thinkingMode: "off" });
    const ui = parseUiSettings(row.ui_settings);
    res.json({
      model: row.default_model ?? "GLM4.7",
      temperature: ui["temperature"] ?? 0.7,
      maxTokens: ui["maxTokens"] ?? 4096,
      maxToolSteps: ui["maxToolSteps"] ?? 10,
      thinkingMode: ui["thinkingMode"] ?? "off",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/settings/model
router.post("/model", (req, res) => {
  try {
    ensureUser(uid(req));
    const body = req.body ?? {};
    const row = db.prepare("SELECT ui_settings FROM user_settings WHERE user_id = ?").get(uid(req)) as { ui_settings?: string };
    const ui = parseUiSettings(row?.ui_settings);
    for (const key of ["temperature", "maxTokens", "maxToolSteps", "thinkingMode"]) {
      if (key in body) ui[key] = body[key];
    }
    const fields = ["ui_settings = ?"];
    const values: unknown[] = [JSON.stringify(ui)];
    if ("model" in body) { fields.push("default_model = ?"); values.push(body.model); }
    values.push(uid(req));
    db.prepare(`UPDATE user_settings SET ${fields.join(", ")} WHERE user_id = ?`).run(...values);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/settings/llm-configs/vllm-models — /:model_id 보다 먼저 등록
router.get("/llm-configs/vllm-models", async (req, res) => {
  try {
    const baseUrl = ((req.query["base_url"] as string) ?? "").replace(/\/$/, "");
    const apiKey = (req.query["api_key"] as string) ?? "";
    if (!baseUrl) return res.status(400).json({ error: "base_url is required" });
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const resp = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return res.status(resp.status).json({ error: `HTTP ${resp.status}` });
    const data = await resp.json() as { data: Array<{ id: string }> };
    res.json({ models: data.data.map(m => m.id).filter(Boolean), base_url: baseUrl });
  } catch (err) {
    res.status(503).json({ error: String(err) });
  }
});

// GET /api/settings/llm-configs
router.get("/llm-configs", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT * FROM llm_model_configs WHERE is_builtin = 1 OR user_id = ? ORDER BY is_builtin DESC, model_id"
    ).all(uid(req));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/settings/llm-configs/:model_id
router.get("/llm-configs/:model_id(*)", (req, res) => {
  try {
    const row = db.prepare(
      "SELECT * FROM llm_model_configs WHERE model_id = ? AND (is_builtin = 1 OR user_id = ?)"
    ).get(req.params["model_id"], uid(req));
    if (!row) {
      return res.json({
        model_id: req.params["model_id"], display_name: req.params["model_id"],
        base_url: "http://vllm.internal/v1", api_key: "", temperature: 0.7,
        max_tokens: 4096, context_window: 128000, is_builtin: 0,
      });
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/settings/llm-configs
router.post("/llm-configs", (req, res) => {
  try {
    const body = req.body ?? {};
    const model_id = (body.model_id ?? "").trim();
    if (!model_id) return res.status(400).json({ error: "model_id is required" });
    if (db.prepare("SELECT model_id FROM llm_model_configs WHERE model_id = ?").get(model_id))
      return res.status(409).json({ error: `Model '${model_id}' already exists. Use PUT to update.` });
    db.prepare(
      "INSERT INTO llm_model_configs (model_id, display_name, base_url, api_key, temperature, max_tokens, context_window, is_builtin, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)"
    ).run(model_id, body.display_name ?? model_id, body.base_url ?? "http://vllm.internal/v1",
      body.api_key ?? "", body.temperature ?? 0.7, body.max_tokens ?? 4096, body.context_window ?? 128000, uid(req));
    res.status(201).json(db.prepare("SELECT * FROM llm_model_configs WHERE model_id = ?").get(model_id));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/settings/llm-configs/:model_id
router.put("/llm-configs/:model_id(*)", (req, res) => {
  try {
    const body = req.body ?? {};
    const model_id = req.params["model_id"];
    const existing = db.prepare(
      "SELECT is_builtin, user_id FROM llm_model_configs WHERE model_id = ?"
    ).get(model_id) as { is_builtin: number; user_id: string | null } | undefined;
    // 다른 유저의 커스텀 모델은 수정 불가
    if (existing && !existing.is_builtin && existing.user_id !== uid(req))
      return res.status(403).json({ error: "Cannot modify another user's model configuration" });
    db.prepare(
      "INSERT INTO llm_model_configs (model_id, display_name, base_url, api_key, temperature, max_tokens, context_window, is_builtin, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(model_id) DO UPDATE SET display_name=excluded.display_name, base_url=excluded.base_url, api_key=excluded.api_key, temperature=excluded.temperature, max_tokens=excluded.max_tokens, context_window=excluded.context_window WHERE is_builtin = 0 AND user_id = excluded.user_id"
    ).run(model_id, body.display_name ?? model_id, body.base_url ?? "http://vllm.internal/v1",
      body.api_key ?? "", body.temperature ?? 0.7, body.max_tokens ?? 4096, body.context_window ?? 128000, uid(req));
    invalidateModelCache(model_id);
    res.json(db.prepare("SELECT * FROM llm_model_configs WHERE model_id = ?").get(model_id));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/settings/llm-configs/:model_id
router.delete("/llm-configs/:model_id(*)", (req, res) => {
  try {
    const model_id = req.params["model_id"];
    const row = db.prepare(
      "SELECT is_builtin FROM llm_model_configs WHERE model_id = ? AND (is_builtin = 1 OR user_id = ?)"
    ).get(model_id, uid(req)) as { is_builtin: number } | undefined;
    if (!row) return res.status(404).json({ error: "Model not found" });
    if (row.is_builtin) return res.status(403).json({ error: "Built-in models cannot be deleted" });
    db.prepare("DELETE FROM llm_model_configs WHERE model_id = ? AND user_id = ? AND is_builtin = 0").run(model_id, uid(req));
    invalidateModelCache(model_id);
    res.json({ deleted: model_id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/settings/model-health
router.get("/model-health", async (req, res) => {
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
    const rows = db.prepare(
      "SELECT model_id, base_url, api_key FROM llm_model_configs WHERE is_builtin = 1 OR user_id = ?"
    ).all(uid(req)) as Array<{ model_id: string; base_url: string; api_key: string }>;

    const checks = rows.map(async (row) => {
      const baseUrl = (row.base_url ?? "").replace(/\/$/, "");
      if (!baseUrl) return [row.model_id, false] as [string, boolean];
      const headers: Record<string, string> = {};
      let apiKey = row.api_key ?? "";
      if (baseUrl.includes("openai.com") || row.model_id.startsWith("gpt-")) apiKey = OPENAI_API_KEY || apiKey;
      if (apiKey && apiKey !== "none") headers["Authorization"] = `Bearer ${apiKey}`;
      try {
        const resp = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(3000) });
        return [row.model_id, resp.status < 500] as [string, boolean];
      } catch {
        return [row.model_id, false] as [string, boolean];
      }
    });

    const results = await Promise.all(checks);
    res.json(Object.fromEntries(results));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
