import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { loadSkills, formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import type { WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { resolveModel, models } from "./models.js";
import { ragTool } from "./tools/rag.js";
import { loadAllMcpTools } from "./tools/mcp.js";
import db from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = process.env.SKILLS_DIR
  ? path.resolve(process.env.SKILLS_DIR)
  : path.join(__dirname, "../../skills");
const USER_SKILLS_BASE = process.env.USER_SKILLS_DIR
  ? path.resolve(process.env.USER_SKILLS_DIR)
  : path.join(__dirname, "../../skills-user");

interface ChatConfig {
  model: string;
  indexes: string[];
  tools: string[];
  temperature?: number;
  maxTokens?: number;
  maxToolSteps?: number;
  thinkingMode?: string;
}

interface JiraServer { id: string; name: string; url: string; enabled: number; }

function buildSystemPrompt(_sessionId: string, userId: string): string {
  let agentMd = "";
  let jiraServersSection = "";

  try {
    const settingsRow = db.prepare("SELECT agent_md FROM user_settings WHERE user_id = ?").get(userId) as { agent_md?: string } | undefined;
    agentMd = settingsRow?.agent_md ?? "";

    const jiraServers = db.prepare("SELECT id, name FROM jira_servers WHERE enabled = 1").all() as JiraServer[];
    if (jiraServers.length > 0) {
      jiraServersSection = `\n등록된 Jira 서버 (특정 서버 지정 시 serverId 사용; 미지정 시 백엔드가 자동 라우팅):\n` +
        jiraServers.map(s => `  - id: "${s.id}"  name: "${s.name}"`).join("\n");
    }
  } catch { /* 기본 프롬프트 사용 */ }

  const userSkillsDir = path.join(USER_SKILLS_BASE, userId);
  const { skills } = loadSkills({ skillPaths: [SKILLS_DIR, userSkillsDir], includeDefaults: false });
  const skillsSection = formatSkillsForPrompt(skills);

  return `당신은 BT/WiFi 펌웨어 엔지니어링팀을 위한 AI 어시스턴트 Connpass입니다.

사내 문서 검색(RAG), Jira 이슈 조회/검색, Gerrit 코드리뷰 등을 지원합니다.
기술 용어는 원문(영어)을 우선 사용하고, 한국어로 답변합니다.
답변 마지막에는 관련 후속 액션을 1~3개 제안해주세요.
${jiraServersSection}
${agentMd ? `\n---\n사용자 커스텀 지시사항:\n${agentMd}` : ""}${skillsSection}`;
}

export async function createAgent(
  ws: WebSocket,
  sessionId: string,
  config: ChatConfig,
  userId: string,
  assistantMessageId: string
) {
  // OpenAI 모델은 정적, 사내 vLLM 모델은 DB에서 최신 설정을 동적으로 로드
  const isOpenAI = config.model.startsWith("gpt-");
  let model = models[config.model] ?? models["GLM4.7"];
  let temperature = 0.7;
  let apiKey = "";

  if (!isOpenAI) {
    const resolved = await resolveModel(config.model);
    model = resolved.model;
    temperature = resolved.temperature;
    apiKey = resolved.apiKey;
  }

  const systemPrompt = buildSystemPrompt(sessionId, userId);

  // tool 목록 구성
  const toolList = [];
  if (config.tools.includes("rag")) toolList.push(ragTool(config.indexes));

  // 로컬 MCP 서버 툴 동적 로드 (Jira, Gerrit 등 모두 포함)
  const mcpTools = await loadAllMcpTools(userId).catch(() => []);
  toolList.push(...mcpTools);

  // temperature를 streamFn에 주입 (pi-agent-core Agent가 temperature를 직접 지원하지 않으므로 래핑)
  // OpenAI 모델: apiKey를 넘기지 않아야 pi-ai가 OPENAI_API_KEY 환경변수를 사용함
  // 사내 vLLM: apiKey가 없으면 "none" 전달 (pi-ai 빈값 에러 방지, vLLM은 값 무관)
  const streamFnWithConfig = (m: Parameters<typeof streamSimple>[0], ctx: Parameters<typeof streamSimple>[1], opts?: Parameters<typeof streamSimple>[2]) =>
    streamSimple(m, ctx, {
      ...opts,
      temperature,
      ...(isOpenAI ? {} : { apiKey: apiKey || "none" }),
    });

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: toolList,
      thinkingLevel: (config.thinkingMode ?? "off") as "off" | "minimal" | "low" | "medium" | "high",
    },
    streamFn: streamFnWithConfig,
  });

  // tool call 순서 추적
  let toolCallOrder = 0;

  // 이벤트 → WebSocket 브로드캐스트
  agent.subscribe((event) => {
    console.log(`[Agent] event=${event.type}`);
    switch (event.type) {
      case "message_update":
        console.log(`[Agent] assistantMsgEvent=${JSON.stringify((event as { assistantMessageEvent?: unknown }).assistantMessageEvent)?.slice(0,80)}`);
        if (event.assistantMessageEvent.type === "thinking_delta") {
          ws.send(JSON.stringify({
            type: "thinking",
            sessionId,
            delta: event.assistantMessageEvent.delta,
          }));
        } else if (event.assistantMessageEvent.type === "text_delta") {
          ws.send(JSON.stringify({
            type: "token",
            sessionId,
            delta: event.assistantMessageEvent.delta,
          }));
        }
        break;

      case "tool_execution_start": {
        const toolLabel = (event as { toolLabel?: string }).toolLabel ?? event.toolName;
        ws.send(JSON.stringify({
          type: "tool_start",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolLabel,
          params: event.args,
        }));
        // DB 저장
        try {
          db.prepare(
            `INSERT INTO tool_calls (id, message_id, session_id, tool_name, tool_label, args, started_at, order_idx)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            event.toolCallId,
            assistantMessageId,
            sessionId,
            event.toolName,
            toolLabel,
            JSON.stringify(event.args ?? {}),
            new Date().toISOString(),
            toolCallOrder++
          );
        } catch (e) { console.error("[Agent] tool_call insert error:", e); }
        break;
      }

      case "tool_execution_end": {
        const details = event.result?.details ?? {};
        const isError = event.result?.isError ?? false;
        ws.send(JSON.stringify({
          type: "tool_end",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          details,
        }));
        // DB 업데이트
        try {
          db.prepare(
            `UPDATE tool_calls SET result = ?, is_error = ?, ended_at = ? WHERE id = ?`
          ).run(
            JSON.stringify(details),
            isError ? 1 : 0,
            new Date().toISOString(),
            event.toolCallId
          );
        } catch (e) { console.error("[Agent] tool_call update error:", e); }
        break;
      }

      case "agent_end":
        ws.send(JSON.stringify({
          type: "agent_end",
          sessionId,
          totalTokens: 0, // pi-agent-core에서 누적 토큰 제공 시 업데이트
        }));
        break;
    }
  });

  return agent;
}
