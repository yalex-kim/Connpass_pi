/**
 * Connpass — 기능 테스트 모듈
 * 실행: npx tsx test.ts
 *
 * 테스트 항목:
 *  1. Flask API 연결
 *  2. WebSocket 연결
 *  3. sessions.list
 *  4. 세션 생성 → 첫 번째 채팅 → 응답 수신
 *  5. 세션 히스토리 복원 → 두 번째 채팅 (이전 대화 기억)
 *  6. 번역 모드
 *  7. 세션 삭제
 */

import "dotenv/config";
import { WebSocket } from "ws";

const FLASK_URL = process.env.FLASK_API_URL ?? "http://localhost:5000";
const WS_URL = `ws://localhost:${process.env.WS_PORT ?? "3000"}`;
const MODEL = "gpt-4o-mini";

// ── 결과 집계 ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function ok(label: string, detail = "") {
  console.log(`  ✓ ${label}${detail ? " — " + detail : ""}`);
  passed++;
}

function fail(label: string, detail = "") {
  console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  failed++;
}

// ── 헬퍼: WebSocket 채팅 ──────────────────────────────────────────────────
function wsChat(
  sessionId: string,
  message: string,
  type: "chat" | "translate" = "chat",
  extraConfig: Record<string, unknown> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let response = "";
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("TIMEOUT (20s)"));
    }, 20000);

    ws.on("open", () => {
      if (type === "translate") {
        ws.send(JSON.stringify({
          type: "translate",
          sessionId,
          text: message,
          config: { model: MODEL, targetLang: "KO", translatePrompt: "", ...extraConfig },
        }));
      } else {
        ws.send(JSON.stringify({
          type: "chat",
          sessionId,
          message,
          config: {
            model: MODEL,
            indexes: [],
            tools: [],
            temperature: 0.7,
            maxTokens: 100,
            maxToolSteps: 1,
            thinkingMode: "off",
            ...extraConfig,
          },
        }));
      }
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; delta?: string; message?: string };
      if (msg.type === "token" && msg.delta) response += msg.delta;
      if (msg.type === "error") { clearTimeout(timeout); ws.close(); reject(new Error(msg.message ?? "AGENT_ERROR")); }
      if (msg.type === "agent_end") { clearTimeout(timeout); ws.close(); resolve(response); }
    });

    ws.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

// ── 헬퍼: 세션 생성 ──────────────────────────────────────────────────────
async function createSession(): Promise<string> {
  const res = await fetch(`${FLASK_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona: "BT", model: MODEL }),
  });
  if (!res.ok) throw new Error(`세션 생성 실패: ${res.status}`);
  const data = await res.json() as { id: string };
  return data.id;
}

// ══════════════════════════════════════════════════════════════════════════
// 테스트 실행
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("=".repeat(55));
  console.log("  Connpass 기능 테스트");
  console.log("=".repeat(55));

  // ── 1. Flask API 연결 ────────────────────────────────────────────────
  console.log("\n[1] Flask API 연결");
  try {
    const res = await fetch(`${FLASK_URL}/health`);
    if (res.ok) ok("GET /health");
    else fail("GET /health", `status ${res.status}`);
  } catch (e) {
    fail("GET /health", String(e));
  }

  try {
    const res = await fetch(`${FLASK_URL}/api/sessions`);
    if (res.ok) ok("GET /api/sessions");
    else fail("GET /api/sessions", `status ${res.status}`);
  } catch (e) {
    fail("GET /api/sessions", String(e));
  }

  // ── 2. WebSocket 연결 ────────────────────────────────────────────────
  console.log("\n[2] WebSocket 연결");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);
    let timer: ReturnType<typeof setTimeout>;
    const done = (fn: () => void) => { clearTimeout(timer); fn(); ws.close(); resolve(); };
    ws.on("open", () => done(() => ok("ws://localhost 연결")));
    ws.on("error", (e) => done(() => fail("ws://localhost 연결", e.message)));
    timer = setTimeout(() => { fail("ws://localhost 연결", "TIMEOUT"); ws.close(); resolve(); }, 5000);
  });

  // ── 3. sessions.list ─────────────────────────────────────────────────
  console.log("\n[3] sessions.list (WebSocket)");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);
    let timer: ReturnType<typeof setTimeout>;
    const done = (fn: () => void) => { clearTimeout(timer); fn(); ws.close(); resolve(); };
    ws.on("open", () => ws.send(JSON.stringify({ type: "sessions.list" })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; sessions?: unknown[] };
      if (msg.type === "sessions.list") {
        done(() => ok("sessions.list 응답", `${msg.sessions?.length ?? 0}개 세션`));
      }
    });
    ws.on("error", (e) => done(() => fail("sessions.list", e.message)));
    timer = setTimeout(() => { fail("sessions.list", "TIMEOUT"); ws.close(); resolve(); }, 5000);
  });

  // ── 4. 첫 번째 채팅 ──────────────────────────────────────────────────
  console.log("\n[4] 첫 번째 채팅");
  let sessionId = "";
  try {
    sessionId = await createSession();
    ok("세션 생성", sessionId.slice(0, 8) + "...");
  } catch (e) {
    fail("세션 생성", String(e));
    console.log("\n테스트 중단 (세션 생성 실패)");
    printSummary();
    return;
  }

  try {
    const resp = await wsChat(sessionId, "내 코드명은 ALPHA야. 기억해줘.");
    if (resp.length > 0) ok("채팅 응답 수신", resp.slice(0, 50));
    else fail("채팅 응답 수신", "빈 응답");
  } catch (e) {
    fail("채팅 응답 수신", String(e));
  }

  // ── 5. 두 번째 채팅 (히스토리 복원) ──────────────────────────────────
  console.log("\n[5] 두 번째 채팅 (세션 히스토리 복원)");
  await new Promise(r => setTimeout(r, 800)); // 저장 완료 대기
  try {
    const resp = await wsChat(sessionId, "내 코드명이 뭐야?");
    if (resp.toLowerCase().includes("alpha")) {
      ok("이전 대화 기억", resp.slice(0, 60));
    } else {
      fail("이전 대화 기억", `'ALPHA' 미포함: ${resp.slice(0, 60)}`);
    }
  } catch (e) {
    fail("이전 대화 기억", String(e));
  }

  // ── 6. 번역 모드 ──────────────────────────────────────────────────────
  console.log("\n[6] 번역 모드");
  try {
    const translateSessionId = await createSession();
    const resp = await wsChat(
      translateSessionId,
      "Hello, this is a translation test.",
      "translate"
    );
    if (resp.length > 0 && !/Hello.*assist/i.test(resp)) {
      ok("번역 응답 수신", resp.slice(0, 60));
    } else {
      fail("번역 응답 수신", `번역 안 됨: ${resp.slice(0, 60)}`);
    }
  } catch (e) {
    fail("번역 모드", String(e));
  }

  // ── 7. 세션 삭제 ──────────────────────────────────────────────────────
  console.log("\n[7] 세션 삭제");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);
    let timer: ReturnType<typeof setTimeout>;
    const done = (fn: () => void) => { clearTimeout(timer); fn(); ws.close(); resolve(); };
    ws.on("open", () => ws.send(JSON.stringify({ type: "sessions.delete", sessionId })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; sessionId?: string };
      if (msg.type === "sessions.deleted") {
        done(() => ok("세션 삭제", sessionId.slice(0, 8) + "..."));
      }
    });
    ws.on("error", (e) => done(() => fail("세션 삭제", e.message)));
    timer = setTimeout(() => { fail("세션 삭제", "TIMEOUT"); ws.close(); resolve(); }, 5000);
  });

  // ── 확인: 삭제된 세션 조회 실패 확인 ──────────────────────────────────
  try {
    const res = await fetch(`${FLASK_URL}/api/sessions/${sessionId}`);
    if (res.status === 404) ok("삭제 후 404 확인");
    else fail("삭제 후 404 확인", `status ${res.status}`);
  } catch (e) {
    fail("삭제 후 404 확인", String(e));
  }

  printSummary();
}

function printSummary() {
  const total = passed + failed;
  console.log("\n" + "=".repeat(55));
  console.log(`  결과: ${passed}/${total} 통과  (실패: ${failed})`);
  console.log("=".repeat(55));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("테스트 실행 오류:", e);
  process.exit(1);
});
