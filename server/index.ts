import "dotenv/config";
import { createServer } from "http";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createAgent } from "./agent.js";
import { translateDirect } from "./translate.js";

const PORT = parseInt(process.env.WS_PORT ?? "5001", 10);
const FLASK_URL = process.env.FLASK_API_URL ?? "http://localhost:5000";
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_PATH = process.env.FRONTEND_PATH ?? join(__dirname, "../frontend");

interface SessionState {
  agent: Awaited<ReturnType<typeof createAgent>> | null;
  controller: AbortController;
}

const sessions = new Map<string, SessionState>();

function userHeaders(userId: string): Record<string, string> {
  return { "Content-Type": "application/json", "X-User-Id": userId };
}

async function saveMessage(sessionId: string, role: string, content: unknown, userId: string) {
  try {
    await fetch(`${FLASK_URL}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: userHeaders(userId),
      body: JSON.stringify({ role, content: JSON.stringify(content) }),
    });
  } catch { /* 저장 실패 무시 */ }
}

async function loadHistory(sessionId: string, userId: string) {
  try {
    const res = await fetch(`${FLASK_URL}/api/sessions/${sessionId}`, {
      headers: { "X-User-Id": userId },
    });
    if (!res.ok) return [];
    const data = await res.json() as { messages: Array<{ role: string; content: string }> };
    return data.messages.map(m => {
      const parsed = JSON.parse(m.content);
      if (m.role === "assistant" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...parsed };
      }
      return { role: m.role, content: parsed, timestamp: Date.now() };
    });
  } catch { return []; }
}

async function generateTitle(firstMessage: string, model: string, userId: string) {
  try {
    const res = await fetch(`${FLASK_URL}/api/sessions/generate-title`, {
      method: "POST",
      headers: userHeaders(userId),
      body: JSON.stringify({ message: firstMessage, model }),
    });
    if (res.ok) {
      const data = await res.json() as { title: string };
      return data.title;
    }
  } catch { /* 실패 무시 */ }
  return firstMessage.slice(0, 30);
}

// ─── Express + HTTP 서버 ──────────────────────────────────────────────────────
const app = express();

// Flask API 프록시 (정적 파일보다 먼저 등록해야 /api 경로가 우선 처리됨)
app.use(createProxyMiddleware({
  target: FLASK_URL,
  changeOrigin: true,
  pathFilter: (pathname: string) => pathname.startsWith("/api") || pathname === "/health",
}));

// 정적 파일 서빙 (frontend/)
app.use(express.static(FRONTEND_PATH));

const server = createServer(app);

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
  const userId = (req.headers["x-user-id"] as string) ?? "default";
  console.log(`[WS] 클라이언트 연결 (user: ${userId})`);

  // 접속 시 모델 헬스체크 → 클라이언트에 전송
  fetch(`${FLASK_URL}/api/settings/model-health`, {
    headers: { "X-User-Id": userId },
  })
    .then(r => r.ok ? r.json() : {})
    .then((health: Record<string, boolean>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "model_health", health }));
      }
    })
    .catch(() => {});

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
        const res = await fetch(`${FLASK_URL}/api/sessions`, {
          headers: { "X-User-Id": userId },
        });
        const data = await res.json();
        ws.send(JSON.stringify({ type: "sessions.list", sessions: data }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: String(err), code: "SESSIONS_ERROR" }));
      }
      return;
    }

    // ─── 세션 삭제 ───────────────────────────────────────────────────
    if (type === "sessions.delete") {
      try {
        await fetch(`${FLASK_URL}/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers: { "X-User-Id": userId },
        });
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
      const agent = await createAgent(ws, sessionId, config, userId);
      sessions.set(sessionId, { agent, controller });

      const history = await loadHistory(sessionId, userId);
      if (history.length > 0) {
        agent.replaceMessages(history as AgentMessage[]);
      }

      await saveMessage(sessionId, "user", message, userId);

      try {
        await agent.prompt(message);
        const msgs = agent.state.messages;
        const lastAssistant = [...msgs].reverse().find((m) => (m as { role?: string }).role === "assistant");
        if (lastAssistant) await saveMessage(sessionId, "assistant", lastAssistant, userId);
        if (history.length === 0) {
          const title = await generateTitle(message, config.model, userId);
          await fetch(`${FLASK_URL}/api/sessions/${sessionId}`, {
            method: "PATCH",
            headers: userHeaders(userId),
            body: JSON.stringify({ title }),
          });
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          ws.send(JSON.stringify({
            type: "error",
            sessionId,
            message: String(err),
            code: "AGENT_ERROR",
          }));
        }
      } finally {
        sessions.delete(sessionId);
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("[WS] 클라이언트 연결 해제");
  });

  ws.on("error", (err) => {
    console.error("[WS] 에러:", err);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Connpass] 서버 시작: http://localhost:${PORT}`);
});
