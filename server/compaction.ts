/**
 * server/compaction.ts
 *
 * 세션 메시지 히스토리 컴팩션.
 * pi-agent-core는 컴팩션 API를 제공하지 않으므로 직접 구현.
 *
 * 동작:
 *  1. 세션 메시지 토큰 추정 (chars/4)
 *  2. contextWindow * THRESHOLD 초과 시 오래된 메시지를 LLM으로 요약
 *  3. DB: 오래된 메시지 삭제 → 요약 메시지 삽입 (트랜잭션)
 *  4. WS로 compaction 이벤트 전송 (UI에 구분선 표시)
 *
 * 보존 대상 (컴팩션 제외):
 *  - System prompt (agent state에 분리 저장 — DB messages에 없음)
 *  - 최근 KEEP_RECENT 개 메시지
 */

import type { WebSocket } from "ws";
import db from "./db.js";

const COMPACTION_THRESHOLD = 0.75; // contextWindow의 75% 초과 시 트리거
const KEEP_RECENT = 8;             // 최근 N개 메시지는 항상 보존
const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1";

interface MsgRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

/**
 * 세션 히스토리 토큰을 추정하고, 한도 초과 시 LLM으로 요약 후 DB 갱신.
 * @returns true = 컴팩션 실행됨
 */
export async function compactSessionIfNeeded(
  sessionId: string,
  contextWindow: number,
  modelId: string,
  apiKey: string,
  ws: WebSocket
): Promise<boolean> {
  const rows = db.prepare(
    "SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC"
  ).all(sessionId) as MsgRow[];

  if (rows.length < KEEP_RECENT + 2) return false; // 너무 짧으면 스킵

  // 토큰 추정
  const totalChars = rows.reduce((s, r) => s + r.content.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 4);
  const threshold = Math.floor(contextWindow * COMPACTION_THRESHOLD);

  if (estimatedTokens < threshold) return false;

  const toSummarize = rows.slice(0, rows.length - KEEP_RECENT);
  const toKeep      = rows.slice(rows.length - KEEP_RECENT);

  console.log(`[Compaction] session=${sessionId} tokens≈${estimatedTokens}/${contextWindow} → 요약 대상 ${toSummarize.length}개`);

  // UI 알림 — 요약 시작
  _sendWs(ws, sessionId, "대화 이력 요약 중...");

  // LLM 요약 호출
  let summaryText: string;
  try {
    summaryText = await _summarize(toSummarize, modelId, apiKey);
  } catch (err) {
    console.error("[Compaction] 요약 실패:", err);
    _sendWs(ws, sessionId, "이전 대화 요약 실패 — 원본 유지");
    return false;
  }

  // DB 원자적 갱신
  const now = new Date().toISOString();
  const summaryMsgId = crypto.randomUUID();

  // 요약 메시지의 created_at: 보존 대상 첫 메시지보다 1초 앞
  const firstKeptTime = toKeep[0]?.created_at ?? now;
  const summaryTime = new Date(new Date(firstKeptTime).getTime() - 1000).toISOString();

  db.transaction(() => {
    // 오래된 메시지 삭제 (tool_calls는 CASCADE로 자동 삭제)
    const placeholders = toSummarize.map(() => "?").join(",");
    db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...toSummarize.map(r => r.id));

    // 요약 메시지 삽입
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      summaryMsgId,
      sessionId,
      "user",
      JSON.stringify(`[이전 대화 ${toSummarize.length}개 메시지 요약]\n${summaryText}`),
      summaryTime
    );
  })();

  console.log(`[Compaction] 완료: ${toSummarize.length}개 → 요약 1개`);
  _sendWs(ws, sessionId, `이전 대화 ${toSummarize.length}개 메시지 요약 완료`);
  return true;
}

/** LLM으로 메시지 배열을 요약 */
async function _summarize(msgs: MsgRow[], modelId: string, apiKey: string): Promise<string> {
  // 요약용 텍스트 구성: role: content 형태로 단순화
  const textLines = msgs.map(r => {
    let content: unknown;
    try { content = JSON.parse(r.content); } catch { content = r.content; }

    let text: string;
    if (typeof content === "string") {
      text = content;
    } else if (typeof content === "object" && content !== null && "content" in content) {
      // AssistantMessage 구조 — content[] 배열에서 텍스트 추출
      const blocks = (content as { content: Array<{ type: string; text?: string }> }).content;
      text = Array.isArray(blocks)
        ? blocks.filter(b => b.type === "text").map(b => b.text ?? "").join(" ")
        : JSON.stringify(content);
    } else {
      text = JSON.stringify(content);
    }

    return `[${r.role}] ${text.slice(0, 500)}`; // 각 메시지 최대 500자
  }).join("\n");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey !== "none") headers["Authorization"] = `Bearer ${apiKey}`;

  const resp = await fetch(`${VLLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: "system",
          content: "주어진 대화 이력을 한국어로 간결하게 요약하라. 중요한 사실, 결정, 검색 결과 핵심만 보존하라. 500자 이내로 작성하라.",
        },
        {
          role: "user",
          content: `다음 대화 이력을 요약하라:\n\n${textLines}`,
        },
      ],
      max_tokens: 600,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) throw new Error(`LLM 요약 실패: HTTP ${resp.status}`);
  const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content.trim();
}

function _sendWs(ws: WebSocket, sessionId: string, message: string) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "compaction", sessionId, message }));
    }
  } catch { /* WS 닫혀 있으면 무시 */ }
}
