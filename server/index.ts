import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });
import { createServer } from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createAgent } from "./agent.js";
import { translateDirect } from "./translate.js";
import db from "./db.js";
import sessionsRouter from "./routes/sessions.js";
import settingsRouter from "./routes/settings.js";
import mcpRouter from "./routes/mcp.js";
import jiraRouter from "./routes/jira.js";
import gerritRouter from "./routes/gerrit.js";
import skillsRouter from "./routes/skills.js";

const PORT = parseInt(process.env.WS_PORT ?? "5001", 10);

// ─── 재시작 복구: 이전 세션에서 generating=1 상태로 남은 세션 처리 ──────────────
{
  const stuck = db.prepare("SELECT id FROM sessions WHERE generating = 1").all() as Array<{ id: string }>;
  for (const { id } of stuck) {
    const msgId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
      msgId, id, "assistant", JSON.stringify("서버가 재시작되어 응답이 중단되었습니다. 다시 질문해 주세요."), now
    );
    db.prepare("UPDATE sessions SET generating = 0, updated_at = ? WHERE id = ?").run(now, id);
  }
  if (stuck.length > 0) console.log(`[Connpass] 재시작 복구: ${stuck.length}개 세션 처리됨`);
}
const RAGAAS_URL = process.env.RAGAAS_URL ?? "http://ragaas.internal";
const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_PATH = process.env.FRONTEND_PATH ?? join(__dirname, "../frontend");

interface SessionState {
  agent: Awaited<ReturnType<typeof createAgent>> | null;
  controller: AbortController;
}

const sessions = new Map<string, SessionState>();

// ─── DB 직접 헬퍼 ──────────────────────────────────────────────────────────────

function saveMessage(sessionId: string, role: string, content: unknown, messageId?: string) {
  try {
    const msgId = messageId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
      msgId, sessionId, role, JSON.stringify(content), now
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    return msgId;
  } catch { /* 저장 실패 무시 */ }
}

function loadHistory(sessionId: string): AgentMessage[] {
  try {
    const rows = db.prepare(
      "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId) as Array<{ role: string; content: string }>;
    return rows.map(m => {
      const parsed = JSON.parse(m.content);
      if (m.role === "assistant" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...parsed };
      }
      return { role: m.role, content: parsed, timestamp: Date.now() };
    }) as AgentMessage[];
  } catch { return []; }
}

async function generateTitle(message: string, model: string): Promise<string> {
  const messages = [
    { role: "system", content: "다음 메시지를 보고 5단어 이내 한국어 채팅 제목을 만들어라. 제목만 출력하라." },
    { role: "user", content: message.slice(0, 500) },
  ];
  async function call(baseUrl: string, apiKey: string, modelId: string): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST", headers,
      body: JSON.stringify({ model: modelId, messages, max_tokens: 30, temperature: 0.3 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0].message.content.trim();
  }
  try {
    if (OPENAI_MODELS.has(model) && OPENAI_API_KEY) return await call("https://api.openai.com/v1", OPENAI_API_KEY, model);
    return await call(VLLM_BASE_URL, "", model);
  } catch { return message.slice(0, 30); }
}

// ─── Express + HTTP 서버 ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// RAG 라우트 — RAGaaS 직접 호출
app.post("/api/rag/search", async (req, res) => {
  try {
    const resp = await fetch(`${RAGAAS_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    });
    res.json(await resp.json());
  } catch (err) {
    res.json({ results: [], error: String(err) });
  }
});

app.get("/api/rag/indexes", async (_req, res) => {
  try {
    const resp = await fetch(`${RAGAAS_URL}/indexes`, { signal: AbortSignal.timeout(10000) });
    res.json(await resp.json());
  } catch (err) {
    res.json({ indexes: [], error: String(err) });
  }
});

// API 라우트 등록
app.use("/api", sessionsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/mcp", mcpRouter);
app.use("/api/jira", jiraRouter);
app.use("/api/gerrit", gerritRouter);
app.use("/api", skillsRouter);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "Connpass" }));

// 정적 파일 서빙 (frontend/)
app.use(express.static(FRONTEND_PATH));

const server = createServer(app);

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
  const userId = (req.headers["x-user-id"] as string) ?? "default";
  console.log(`[WS] 클라이언트 연결 (user: ${userId})`);

  // 접속 시 모델 헬스체크
  (async () => {
    try {
      const rows = db.prepare(
        "SELECT model_id, base_url, api_key FROM llm_model_configs WHERE is_builtin = 1 OR user_id = ?"
      ).all(userId) as Array<{ model_id: string; base_url: string; api_key: string }>;
      const checks = rows.map(async (row) => {
        const headers: Record<string, string> = {};
        let apiKey = row.api_key ?? "";
        if ((row.base_url ?? "").includes("openai.com") || row.model_id.startsWith("gpt-"))
          apiKey = OPENAI_API_KEY || apiKey;
        if (apiKey && apiKey !== "none") headers["Authorization"] = `Bearer ${apiKey}`;
        try {
          const resp = await fetch(`${row.base_url}/models`, { headers, signal: AbortSignal.timeout(3000) });
          return [row.model_id, resp.status < 500] as [string, boolean];
        } catch { return [row.model_id, false] as [string, boolean]; }
      });
      const results = await Promise.all(checks);
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "model_health", health: Object.fromEntries(results) }));
    } catch { /* 무시 */ }
  })();

  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "잘못된 메시지 형식", code: "PARSE_ERROR" }));
      return;
    }

    const { type, sessionId } = msg as { type: string; sessionId: string };
    console.log(`[WS] msg type=${type} session=${sessionId}`);

    // ─── 세션 목록 ───────────────────────────────────────────────────
    if (type === "sessions.list") {
      try {
        const rows = db.prepare(
          "SELECT id, title, persona, model, created_at, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"
        ).all(userId);
        ws.send(JSON.stringify({ type: "sessions.list", sessions: rows }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: String(err), code: "SESSIONS_ERROR" }));
      }
      return;
    }

    // ─── 세션 삭제 ───────────────────────────────────────────────────
    if (type === "sessions.delete") {
      try {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        sessions.delete(sessionId);
        ws.send(JSON.stringify({ type: "sessions.deleted", sessionId }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", sessionId, message: String(err), code: "DELETE_ERROR" }));
      }
      return;
    }

    // ─── Stop ────────────────────────────────────────────────────────
    if (type === "stop") {
      const state = sessions.get(sessionId);
      if (state) {
        state.agent?.abort();
        state.controller.abort();
        sessions.delete(sessionId);
      }
      return;
    }

    // ─── 번역 ────────────────────────────────────────────────────────
    if (type === "translate") {
      const { text, config } = msg as {
        text: string;
        config: { model: string; targetLang: "KO" | "EN" | "JA" | "ZH"; translatePrompt: string };
      };
      const controller = new AbortController();
      sessions.set(sessionId, { agent: null, controller });
      await translateDirect(ws, sessionId, text, config, controller.signal);
      sessions.delete(sessionId);
      return;
    }

    // ─── 채팅 ────────────────────────────────────────────────────────
    if (type === "chat") {
      const { message, config } = msg as {
        message: string;
        config: {
          model: string;
          indexes: string[];
          tools: string[];
          temperature?: number;
          maxTokens?: number;
          maxToolSteps?: number;
          thinkingMode?: string;
        };
      };

      const existing = sessions.get(sessionId);
      if (existing) existing.controller.abort();

      const controller = new AbortController();
      const assistantMsgId = crypto.randomUUID();
      const agent = await createAgent(ws, sessionId, config, userId, assistantMsgId);
      sessions.set(sessionId, { agent, controller });

      const history = loadHistory(sessionId);
      if (history.length > 0) agent.replaceMessages(history);

      saveMessage(sessionId, "user", message);
      db.prepare("UPDATE sessions SET generating = 1 WHERE id = ?").run(sessionId);

      try {
        await agent.prompt(message);
        const msgs = agent.state.messages;
        const lastAssistant = [...msgs].reverse().find((m) => (m as { role?: string }).role === "assistant");
        if (lastAssistant) saveMessage(sessionId, "assistant", lastAssistant, assistantMsgId);
        if (history.length === 0) {
          const title = await generateTitle(message, config.model);
          db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
            title, new Date().toISOString(), sessionId
          );
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          ws.send(JSON.stringify({ type: "error", sessionId, message: String(err), code: "AGENT_ERROR" }));
        }
      } finally {
        db.prepare("UPDATE sessions SET generating = 0 WHERE id = ?").run(sessionId);
        sessions.delete(sessionId);
      }
      return;
    }
  });

  ws.on("close", () => console.log("[WS] 클라이언트 연결 해제"));
  ws.on("error", (err) => console.error("[WS] 에러:", err));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Connpass] 서버 시작: http://localhost:${PORT}`);
});
