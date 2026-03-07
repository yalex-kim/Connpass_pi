import { Router } from "express";
import db from "../db.js";

const router = Router();
const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]);

function uid(req: import("express").Request): string {
  return (req.headers["x-user-id"] as string) ?? "default";
}

async function callLLM(baseUrl: string, apiKey: string, model: string, messages: object[]): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, max_tokens: 30, temperature: 0.3 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content.trim();
}

// POST /api/sessions/generate-title — 반드시 /:id 보다 먼저 등록
router.post("/sessions/generate-title", async (req, res) => {
  try {
    const { message = "", model = "GLM4.7" } = req.body ?? {};
    if (!message) return res.status(400).json({ error: "message is required" });
    const messages = [
      { role: "system", content: "다음 메시지를 보고 5단어 이내 한국어 채팅 제목을 만들어라. 제목만 출력하라." },
      { role: "user", content: (message as string).slice(0, 500) },
    ];
    let title = (message as string).slice(0, 30);
    try {
      if (OPENAI_MODELS.has(model) && OPENAI_API_KEY) {
        title = await callLLM("https://api.openai.com/v1", OPENAI_API_KEY, model, messages);
      } else {
        title = await callLLM(VLLM_BASE_URL, "", model, messages);
      }
    } catch { /* 실패 시 첫 30자 */ }
    res.json({ title });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/sessions
router.get("/sessions", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT id, title, persona, model, created_at, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"
    ).all(uid(req));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sessions
router.post("/sessions", (req, res) => {
  try {
    const body = req.body ?? {};
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO sessions (id, user_id, title, persona, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, uid(req), body.title ?? "새 대화", body.persona ?? null, body.model ?? "GLM4.7", now, now);
    res.status(201).json(
      db.prepare("SELECT id, title, persona, model, created_at, updated_at FROM sessions WHERE id = ?").get(id)
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/sessions/:id
router.get("/sessions/:id", (req, res) => {
  try {
    const session = db.prepare(
      "SELECT id, title, persona, model, created_at, updated_at FROM sessions WHERE id = ?"
    ).get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const messages = db.prepare(
      "SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC"
    ).all(req.params.id);

    // tool_calls를 message_id 기준으로 그룹핑
    const toolCallRows = db.prepare(
      "SELECT id, message_id, tool_name, tool_label, args, result, is_error, started_at, ended_at, order_idx FROM tool_calls WHERE session_id = ? ORDER BY order_idx ASC"
    ).all(req.params.id) as Array<{
      id: string; message_id: string; tool_name: string; tool_label: string;
      args: string; result: string; is_error: number;
      started_at: string; ended_at: string; order_idx: number;
    }>;

    const toolCallsByMessage: Record<string, object[]> = {};
    for (const tc of toolCallRows) {
      if (!toolCallsByMessage[tc.message_id]) toolCallsByMessage[tc.message_id] = [];
      toolCallsByMessage[tc.message_id].push({
        id: tc.id,
        toolName: tc.tool_name,
        toolLabel: tc.tool_label,
        args: tc.args ? JSON.parse(tc.args) : {},
        result: tc.result ? JSON.parse(tc.result) : null,
        isError: tc.is_error === 1,
        startedAt: tc.started_at,
        endedAt: tc.ended_at,
        orderIdx: tc.order_idx,
      });
    }

    res.json({ ...(session as object), messages, toolCallsByMessage });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /api/sessions/:id
router.patch("/sessions/:id", (req, res) => {
  try {
    if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(req.params.id))
      return res.status(404).json({ error: "Session not found" });
    const body = req.body ?? {};
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const f of ["title", "persona", "model"]) {
      if (f in body) { fields.push(`${f} = ?`); values.push(body[f]); }
    }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    fields.push("updated_at = ?");
    values.push(new Date().toISOString(), req.params.id);
    db.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    res.json(db.prepare("SELECT id, title, persona, model, created_at, updated_at FROM sessions WHERE id = ?").get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/sessions/:id
router.delete("/sessions/:id", (req, res) => {
  try {
    if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(req.params.id))
      return res.status(404).json({ error: "Session not found" });
    db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sessions/:id/messages
router.post("/sessions/:id/messages", (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body.role || body.content === undefined)
      return res.status(400).json({ error: "role and content are required" });
    if (!["system", "user", "assistant", "tool"].includes(body.role))
      return res.status(400).json({ error: "Invalid role" });
    if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(req.params.id))
      return res.status(404).json({ error: "Session not found" });
    const msgId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
      msgId, req.params.id, body.role, body.content, now
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, req.params.id);
    res.status(201).json(
      db.prepare("SELECT id, session_id, role, content, created_at FROM messages WHERE id = ?").get(msgId)
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sessions/:id/upload (Phase 8 스텁)
router.post("/sessions/:id/upload", (req, res) => {
  if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(req.params.id))
    return res.status(404).json({ error: "Session not found" });
  res.status(202).json({ status: "stub", session_id: req.params.id, message: "File upload will be implemented in Phase 8" });
});

export default router;
