import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });

import readline from "readline";
import db from "./db.js";
import { createAgent } from "./agent.js";
import { getCodingTools } from "./tools/coding.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ─── ANSI 컬러 ─────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

const VERSION = "0.1.0";

// ─── CLI 인수 파싱 ────────────────────────────────────────────────────────────
function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const opts = {
    user: process.env.USER ?? "default",
    session: "",
    newSession: false,
    model: "",
    cwd: process.cwd(),
    noCoding: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--user":     opts.user       = args[++i]; break;
      case "--session":  opts.session    = args[++i]; break;
      case "--new":      opts.newSession = true;       break;
      case "--model":    opts.model      = args[++i]; break;
      case "--cwd":      opts.cwd        = args[++i]; break;
      case "--no-coding": opts.noCoding  = true;       break;
      case "--help": case "-h":    opts.help    = true; break;
      case "--version": case "-v": opts.version = true; break;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`${c.bold}Connpass CLI${c.reset} v${VERSION}

사용법: connpass [옵션]

옵션:
  --user <id>       사용자 ID (기본: $USER 또는 "default")
  --session <id>    기존 세션 ID로 바로 시작
  --new             새 세션 강제 생성
  --model <id>      모델 ID (기본: 사용자 설정 → "GLM4.7")
  --cwd <path>      코딩 에이전트 작업 디렉토리 (기본: 현재 디렉토리)
  --no-coding       코딩 도구 비활성화
  --help, -h        도움말
  --version, -v     버전 출력`);
}

// ─── DB 헬퍼 ─────────────────────────────────────────────────────────────────
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

function listSessions(userId: string, limit = 10) {
  return db.prepare(
    "SELECT id, title, model, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?"
  ).all(userId, limit) as Array<{ id: string; title: string; model: string; updated_at: string }>;
}

function createSession(userId: string, model: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO sessions (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, userId, "새 대화", model, now, now);
  return id;
}

function getDefaultModel(userId: string): string {
  try {
    const row = db.prepare("SELECT default_model FROM user_settings WHERE user_id = ?").get(userId) as { default_model?: string } | undefined;
    return row?.default_model ?? "GLM4.7";
  } catch { return "GLM4.7"; }
}

// ─── 타이틀 생성 ──────────────────────────────────────────────────────────────
const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]);

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

// ─── TerminalTransport ────────────────────────────────────────────────────────
class TerminalTransport {
  send(data: string) {
    try {
      const msg = JSON.parse(data) as {
        type: string;
        delta?: string;
        toolName?: string;
        toolLabel?: string;
        message?: string;
      };
      switch (msg.type) {
        case "thinking":
          if (msg.delta) process.stdout.write(`${c.dim}${msg.delta}${c.reset}`);
          break;
        case "token":
          if (msg.delta) process.stdout.write(msg.delta);
          break;
        case "tool_start":
          process.stdout.write(`\n${c.yellow}  ▸ ${msg.toolLabel ?? msg.toolName ?? ""}${c.reset}`);
          break;
        case "tool_end":
          process.stdout.write(` ${c.green}✓${c.reset}`);
          break;
        case "agent_end":
          process.stdout.write("\n");
          break;
        case "error":
          process.stdout.write(`\n${c.red}오류: ${msg.message}${c.reset}\n`);
          break;
      }
    } catch { /* JSON 파싱 실패 무시 */ }
  }
}

// ─── chat() ──────────────────────────────────────────────────────────────────
let currentAgent: Awaited<ReturnType<typeof createAgent>>["agent"] | null = null;

async function chat(
  sessionId: string,
  message: string,
  userId: string,
  model: string,
  noCoding: boolean,
  cwd: string,
  isFirst: boolean
) {
  const transport = new TerminalTransport();
  const assistantMsgId = crypto.randomUUID();

  const sessionRow = db.prepare("SELECT title FROM sessions WHERE id = ?").get(sessionId) as { title?: string } | undefined;
  const sessionContext = (sessionRow?.title && sessionRow.title !== "새 대화")
    ? sessionRow.title
    : message.slice(0, 200);

  const chatConfig = {
    model,
    indexes: [] as string[],
    tools: ["rag"],
    temperature: 0.7,
  };

  const codingTools = noCoding ? [] : getCodingTools(cwd);

  const { agent, model: resolvedModel, apiKey } = await createAgent(
    transport, sessionId, chatConfig, userId, assistantMsgId, sessionContext, codingTools
  );
  currentAgent = agent;

  const history = loadHistory(sessionId);
  if (history.length > 0) agent.replaceMessages(history);

  saveMessage(sessionId, "user", message);
  db.prepare("UPDATE sessions SET generating = 1 WHERE id = ?").run(sessionId);

  process.stdout.write(`\n${c.cyan}Connpass${c.reset}  `);

  try {
    await agent.prompt(message);
    const msgs = agent.state.messages;
    const lastAssistant = [...msgs].reverse().find((m) => (m as { role?: string }).role === "assistant");
    if (lastAssistant) saveMessage(sessionId, "assistant", lastAssistant, assistantMsgId);

    if (isFirst) {
      generateTitle(message, model).then(title => {
        db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
          title, new Date().toISOString(), sessionId
        );
      }).catch(() => {});
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      process.stdout.write(`\n${c.dim}[중단됨]${c.reset}\n`);
    } else {
      process.stdout.write(`\n${c.red}오류: ${String(err)}${c.reset}\n`);
    }
  } finally {
    currentAgent = null;
    db.prepare("UPDATE sessions SET generating = 0 WHERE id = ?").run(sessionId);
  }
}

// ─── UI 헬퍼 ─────────────────────────────────────────────────────────────────
function printHeader(userId: string, model: string, cwd: string, noCoding: boolean) {
  console.log(`\n${c.bold}Connpass CLI${c.reset}  ${c.dim}v${VERSION}${c.reset}`);
  console.log("─".repeat(60));
  console.log(`사용자: ${c.cyan}${userId}${c.reset}  |  모델: ${c.cyan}${model}${c.reset}`);
  console.log(`코딩 에이전트: ${noCoding ? c.dim + "비활성" + c.reset : c.green + "활성" + c.reset}  |  작업 디렉토리: ${c.dim}${cwd}${c.reset}`);
  console.log(`${c.dim}/help 로 명령어 확인  •  /exit 로 종료${c.reset}\n`);
}

function printSessions(sessions: ReturnType<typeof listSessions>) {
  if (sessions.length === 0) {
    console.log(`${c.dim}  (최근 세션 없음)${c.reset}`);
    return;
  }
  console.log(`${c.dim}최근 세션 (${sessions.length}개):${c.reset}`);
  sessions.forEach((s, i) => {
    const date = s.updated_at.slice(0, 10);
    const title = (s.title ?? "새 대화").length > 40
      ? s.title.slice(0, 37) + "..."
      : (s.title ?? "새 대화").padEnd(40);
    console.log(`  ${c.yellow}${i + 1}${c.reset}  ${title}  ${c.dim}${date}  [${s.model ?? "?"}]${c.reset}`);
  });
  console.log(`  ${c.yellow}n${c.reset}  새 세션 시작\n`);
}

function printSlashHelp() {
  console.log(`${c.bold}명령어:${c.reset}
  /sessions          최근 세션 목록
  /session <id>      세션 전환
  /new               새 세션 생성
  /model [id]        모델 확인/변경
  /cwd [path]        작업 디렉토리 확인/변경
  /help              도움말
  /exit, /quit       종료
`);
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help)    { printHelp(); process.exit(0); }
  if (opts.version) { console.log(`connpass v${VERSION}`); process.exit(0); }

  const userId  = opts.user;
  let model     = opts.model || getDefaultModel(userId);
  let cwd       = opts.cwd;
  const noCoding = opts.noCoding;

  printHeader(userId, model, cwd, noCoding);

  // ─── 세션 결정 ───────────────────────────────────────────────────────────
  let sessionId: string;

  if (opts.session) {
    sessionId = opts.session;
  } else if (opts.newSession) {
    sessionId = createSession(userId, model);
    console.log(`${c.dim}새 세션 생성: ${sessionId}${c.reset}\n`);
  } else {
    const sessions = listSessions(userId, 10);
    printSessions(sessions);

    const selRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await question(selRl, "번호 입력 또는 Enter로 새 세션: ");
    selRl.close();

    const num = parseInt(answer.trim(), 10);
    if (!answer.trim() || answer.trim().toLowerCase() === "n" || isNaN(num) || num < 1 || num > sessions.length) {
      sessionId = createSession(userId, model);
      console.log(`\n${c.dim}새 세션 생성: ${sessionId}${c.reset}\n`);
    } else {
      const picked = sessions[num - 1];
      sessionId = picked.id;
      model = picked.model ?? model;
      console.log(`\n${c.dim}세션 이어받기: ${picked.title}${c.reset}\n`);
    }
  }

  // ─── REPL ────────────────────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let generating = false;
  let ctrlCCount = 0;

  process.on("SIGINT", () => {
    if (generating && currentAgent) {
      currentAgent.abort();
      return;
    }
    ctrlCCount++;
    if (ctrlCCount >= 2) {
      console.log("\n종료합니다.");
      process.exit(0);
    }
    process.stdout.write(`\n${c.dim}종료하려면 /exit 또는 Ctrl+C 한 번 더${c.reset}\n`);
    setTimeout(() => { ctrlCCount = 0; }, 2000);
    rl.prompt();
  });

  let turnCount = 0;
  rl.setPrompt(`\n${c.bold}You${c.reset}  `);
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    ctrlCCount = 0;

    // 슬래시 명령어
    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(" ");
      switch (cmd.toLowerCase()) {
        case "exit": case "quit":
          console.log("종료합니다.");
          process.exit(0);
          break;
        case "help":
          printSlashHelp();
          break;
        case "new":
          sessionId = createSession(userId, model);
          turnCount = 0;
          console.log(`${c.dim}새 세션 생성: ${sessionId}${c.reset}`);
          break;
        case "sessions": {
          const sessions = listSessions(userId, 10);
          printSessions(sessions);
          break;
        }
        case "session":
          if (rest[0]) {
            sessionId = rest[0];
            turnCount = 0;
            console.log(`${c.dim}세션 전환: ${sessionId}${c.reset}`);
          } else {
            console.log(`${c.dim}현재 세션: ${sessionId}${c.reset}`);
          }
          break;
        case "model":
          if (rest[0]) {
            model = rest[0];
            console.log(`${c.dim}모델 변경: ${model}${c.reset}`);
          } else {
            console.log(`${c.dim}현재 모델: ${model}${c.reset}`);
          }
          break;
        case "cwd":
          if (rest[0]) {
            cwd = rest[0];
            console.log(`${c.dim}작업 디렉토리 변경: ${cwd}${c.reset}`);
          } else {
            console.log(`${c.dim}현재 작업 디렉토리: ${cwd}${c.reset}`);
          }
          break;
        default:
          console.log(`${c.dim}알 수 없는 명령어: /${cmd}  (/help 로 도움말)${c.reset}`);
      }
      rl.prompt();
      return;
    }

    // 채팅
    generating = true;
    rl.pause();
    const isFirst = turnCount === 0;
    turnCount++;
    try {
      await chat(sessionId, input, userId, model, noCoding, cwd, isFirst);
    } finally {
      generating = false;
      rl.resume();
      rl.prompt();
    }
  });

  rl.on("close", () => {
    console.log("\n종료합니다.");
    process.exit(0);
  });
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
