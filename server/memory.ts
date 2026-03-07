/**
 * server/memory.ts
 *
 * 사용자 장기기억 모듈.
 *
 * 기억 2종류:
 *  - Type1 (preference): topic_key=NULL, 선호/취향. 코사인 유사도로 중복 감지 후 UPDATE.
 *  - Type2 (issue/project/feature/fact): topic_key 있음. UNIQUE INDEX + UPSERT로 관리.
 *    같은 topic_key의 새 내용 → content 업데이트, prev_content 백업.
 *
 * 임베딩: vLLM /v1/embeddings (실패 시 중요도 순 폴백)
 * 저장: SQLite BLOB (Float32Array)
 * 추출: 세션 종료 후 LLM 호출로 자동 추출
 */

import db from "./db.js";

const VLLM_BASE_URL  = process.env.VLLM_BASE_URL   ?? "http://vllm.internal/v1";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EXTRACTION_MODEL = process.env.MEMORY_EXTRACTION_MODEL ?? process.env.VLLM_DEFAULT_MODEL ?? "GLM4.7";

const COSINE_TOP_K         = 8;
const SIMILARITY_THRESHOLD = 0.72;  // 이 이상이면 관련 기억으로 판단
const DEDUP_THRESHOLD      = 0.88;  // 이 이상이면 중복으로 판단 → UPDATE

export interface Memory {
  id: string;
  user_id: string;
  memory_type: string;
  topic_key: string | null;
  content: string;
  prev_content: string | null;
  importance: number;
  embedding: Buffer | null;
  source_session: string | null;
  access_count: number;
  last_accessed: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryInput {
  content: string;
  memory_type: string;
  topic_key?: string | null;
  importance?: number;
}

interface ExtractedMemory {
  content: string;
  memory_type: string;
  topic_key: string | null;
  importance: number;
}

// ── 임베딩 ────────────────────────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const resp = await fetch(`${VLLM_BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { data: Array<{ embedding: number[] }> };
    return new Float32Array(data.data[0].embedding);
  } catch {
    return null;
  }
}

function float32ToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}

function blobToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── 기억 조회 (세션 시작 시 호출) ────────────────────────────────────────────

/**
 * 세션 컨텍스트와 관련 있는 기억을 조회하여 system prompt 주입용 문자열 반환.
 * vLLM 임베딩 실패 시 중요도 순으로 폴백.
 */
export async function retrieveRelevantMemories(
  userId: string,
  sessionContext: string,
  topK = COSINE_TOP_K
): Promise<string> {
  const all = db.prepare(
    `SELECT id, memory_type, topic_key, content, importance, embedding
     FROM user_memories WHERE user_id = ?
     ORDER BY importance DESC, updated_at DESC LIMIT 200`
  ).all(userId) as Memory[];

  if (all.length === 0) return "";

  // Type1(preference)는 항상 포함 (최대 5개)
  const prefs = all.filter(m => m.memory_type === "preference").slice(0, 5);

  // Type2는 세션 컨텍스트와 유사도 기반 선택
  const type2 = all.filter(m => m.memory_type !== "preference");
  let selectedType2: Memory[] = [];

  if (type2.length > 0 && sessionContext.trim()) {
    const queryEmb = await getEmbedding(sessionContext);
    if (queryEmb) {
      selectedType2 = type2
        .filter(m => m.embedding !== null)
        .map(m => ({ m, score: cosineSimilarity(queryEmb, blobToFloat32(m.embedding as Buffer)) * (1 + (m.importance - 1) * 0.05) }))
        .filter(x => x.score >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK - prefs.length)
        .map(x => x.m);
    } else {
      // 임베딩 실패 → 중요도 상위
      selectedType2 = type2.slice(0, topK - prefs.length);
    }
  }

  const selected = [...prefs, ...selectedType2];
  if (selected.length === 0) return "";

  // 접근 카운트 업데이트 (fire-and-forget)
  const now = new Date().toISOString();
  for (const m of selected) {
    try {
      db.prepare("UPDATE user_memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?")
        .run(now, m.id);
    } catch { /* 무시 */ }
  }

  const lines = selected
    .map(m => `[${m.memory_type}]${m.topic_key ? ` (${m.topic_key})` : ""} ${m.content}`)
    .join("\n");

  return `\n<user_long_term_memory>\n${lines}\n</user_long_term_memory>`;
}

// ── 기억 추출 (세션 종료 후 background 실행) ─────────────────────────────────

export async function extractMemoriesFromSession(
  sessionId: string,
  userId: string
): Promise<void> {
  // 중복 실행 방지
  const existing = db.prepare("SELECT status FROM memory_extractions WHERE session_id = ?")
    .get(sessionId) as { status: string } | undefined;
  if (existing?.status === "done") return;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_extractions (session_id, user_id, status, attempted_at)
     VALUES (?, ?, 'pending', ?)
     ON CONFLICT(session_id) DO UPDATE SET status='pending', attempted_at=excluded.attempted_at`
  ).run(sessionId, userId, now);

  try {
    // 세션 메시지 로드
    const rows = db.prepare(
      "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId) as Array<{ role: string; content: string }>;

    if (rows.length < 2) {
      db.prepare("UPDATE memory_extractions SET status='done', memories_upserted=0, completed_at=? WHERE session_id=?")
        .run(new Date().toISOString(), sessionId);
      return;
    }

    // 메시지를 사람이 읽기 쉬운 형태로 변환
    const conversation = rows.map(r => {
      let content: unknown;
      try { content = JSON.parse(r.content); } catch { content = r.content; }

      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (typeof content === "object" && content !== null && "content" in content) {
        const blocks = (content as { content: Array<{ type: string; text?: string }> }).content;
        text = Array.isArray(blocks)
          ? blocks.filter(b => b.type === "text").map(b => b.text ?? "").join(" ")
          : "";
      } else {
        text = "";
      }
      return text.trim() ? `[${r.role}] ${text.slice(0, 300)}` : null;
    }).filter(Boolean).join("\n");

    if (!conversation.trim()) {
      db.prepare("UPDATE memory_extractions SET status='done', memories_upserted=0, completed_at=? WHERE session_id=?")
        .run(new Date().toISOString(), sessionId);
      return;
    }

    // LLM 호출로 기억 추출
    const extracted = await _callExtractionLLM(conversation);

    if (extracted.length === 0) {
      db.prepare("UPDATE memory_extractions SET status='done', memories_upserted=0, completed_at=? WHERE session_id=?")
        .run(new Date().toISOString(), sessionId);
      return;
    }

    // 기억 UPSERT
    let upsertCount = 0;
    for (const item of extracted) {
      try {
        await _upsertMemory(userId, item, sessionId);
        upsertCount++;
      } catch (e) {
        console.error("[Memory] upsert 실패:", e, item);
      }
    }

    db.prepare(
      "UPDATE memory_extractions SET status='done', memories_upserted=?, completed_at=? WHERE session_id=?"
    ).run(upsertCount, new Date().toISOString(), sessionId);

    console.log(`[Memory] 세션 ${sessionId}: ${upsertCount}개 기억 추출 완료`);
  } catch (err) {
    console.error("[Memory] 추출 실패:", err);
    db.prepare("UPDATE memory_extractions SET status='failed', completed_at=? WHERE session_id=?")
      .run(new Date().toISOString(), sessionId);
  }
}

/** LLM에 대화를 보내서 기억 추출 */
async function _callExtractionLLM(conversation: string): Promise<ExtractedMemory[]> {
  const prompt = `다음 대화에서 사용자에 대해 기억할 만한 중요한 정보를 추출하세요.

카테고리:
- preference: 선호/취향/작업방식 (반복 적용되는 것, topic_key=null)
- issue: Jira 이슈나 버그 (topic_key = 이슈번호, 예: "BT-1234")
- project: 담당 프로젝트/테스트 (topic_key = 프로젝트명)
- feature: 구현 중인 기능 (topic_key = 기능명)
- fact: 중요 사실 — 기기 모델, 펌웨어 버전 등 (topic_key = 주제명 또는 null)

규칙:
- JSON 배열로만 응답하세요 (다른 텍스트 없이)
- 일상적 질문만 있거나 기억할 내용 없으면 [] 반환
- importance: 1(낮음)~5(높음)
- content: 간결하게 1~2문장

형식:
[{"content":"...", "memory_type":"...", "topic_key":"..." or null, "importance":3}]

대화:
${conversation}`;

  const resp = await fetch(`${VLLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) throw new Error(`LLM 추출 실패: HTTP ${resp.status}`);
  const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
  const text = data.choices[0].message.content.trim();

  // JSON 파싱 (LLM이 마크다운 코드블록으로 감쌀 수 있음)
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as unknown[];
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map(item => ({
      content: String(item["content"] ?? "").trim(),
      memory_type: String(item["memory_type"] ?? "fact"),
      topic_key: item["topic_key"] ? String(item["topic_key"]).trim() : null,
      importance: Math.min(5, Math.max(1, Number(item["importance"] ?? 3))),
    }))
    .filter(item => item.content.length > 0);
}

/** 기억 UPSERT 로직 */
async function _upsertMemory(
  userId: string,
  item: ExtractedMemory,
  sessionId: string
): Promise<void> {
  const now = new Date().toISOString();
  const embedding = await getEmbedding(item.content);
  const embBlob = embedding ? float32ToBlob(embedding) : null;

  if (item.topic_key) {
    // Type2: topic_key 기준 UPSERT
    const existing = db.prepare(
      "SELECT id, content FROM user_memories WHERE user_id = ? AND topic_key = ?"
    ).get(userId, item.topic_key) as Memory | undefined;

    if (existing) {
      db.prepare(
        `UPDATE user_memories
         SET content=?, prev_content=?, importance=?, embedding=?, source_session=?, updated_at=?
         WHERE id=?`
      ).run(item.content, existing.content, item.importance, embBlob, sessionId, now, existing.id);
    } else {
      db.prepare(
        `INSERT INTO user_memories
         (id, user_id, memory_type, topic_key, content, importance, embedding, source_session, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(), userId, item.memory_type, item.topic_key,
        item.content, item.importance, embBlob, sessionId, now, now
      );
    }
  } else {
    // Type1 (preference 등 topic_key 없음): 코사인 유사도로 중복 감지
    if (embedding) {
      const prefs = db.prepare(
        "SELECT id, content, embedding FROM user_memories WHERE user_id = ? AND topic_key IS NULL"
      ).all(userId) as Memory[];

      const duplicate = prefs.find(m => {
        if (!m.embedding) return false;
        return cosineSimilarity(embedding, blobToFloat32(m.embedding as Buffer)) >= DEDUP_THRESHOLD;
      });

      if (duplicate) {
        db.prepare(
          "UPDATE user_memories SET content=?, prev_content=?, importance=?, embedding=?, source_session=?, updated_at=? WHERE id=?"
        ).run(item.content, duplicate.content, item.importance, embBlob, sessionId, now, duplicate.id);
        return;
      }
    }

    // 신규 삽입
    db.prepare(
      `INSERT INTO user_memories
       (id, user_id, memory_type, topic_key, content, importance, embedding, source_session, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(), userId, item.memory_type,
      item.content, item.importance, embBlob, sessionId, now, now
    );
  }
}

// ── 공개 CRUD (REST API에서 호출) ────────────────────────────────────────────

export function listMemories(userId: string, type?: string): Memory[] {
  if (type) {
    return db.prepare(
      "SELECT * FROM user_memories WHERE user_id = ? AND memory_type = ? ORDER BY importance DESC, updated_at DESC"
    ).all(userId, type) as Memory[];
  }
  return db.prepare(
    "SELECT * FROM user_memories WHERE user_id = ? ORDER BY importance DESC, updated_at DESC"
  ).all(userId) as Memory[];
}

export function getMemory(userId: string, id: string): Memory | undefined {
  return db.prepare(
    "SELECT * FROM user_memories WHERE id = ? AND user_id = ?"
  ).get(id, userId) as Memory | undefined;
}

export async function createMemory(userId: string, input: MemoryInput): Promise<Memory> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const embedding = await getEmbedding(input.content);
  const embBlob = embedding ? float32ToBlob(embedding) : null;

  db.prepare(
    `INSERT INTO user_memories
     (id, user_id, memory_type, topic_key, content, importance, embedding, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, userId, input.memory_type, input.topic_key ?? null,
    input.content, input.importance ?? 3, embBlob, now, now
  );
  return db.prepare("SELECT * FROM user_memories WHERE id = ?").get(id) as Memory;
}

export async function updateMemory(
  userId: string,
  id: string,
  patch: { content?: string; importance?: number }
): Promise<Memory | undefined> {
  const existing = db.prepare("SELECT * FROM user_memories WHERE id = ? AND user_id = ?")
    .get(id, userId) as Memory | undefined;
  if (!existing) return undefined;

  const now = new Date().toISOString();
  const newContent = patch.content ?? existing.content;
  const newImportance = patch.importance ?? existing.importance;

  let embBlob: Buffer | null = existing.embedding as Buffer | null;
  if (patch.content && patch.content !== existing.content) {
    const emb = await getEmbedding(newContent);
    embBlob = emb ? float32ToBlob(emb) : null;
  }

  db.prepare(
    `UPDATE user_memories
     SET content=?, prev_content=?, importance=?, embedding=?, updated_at=?
     WHERE id=? AND user_id=?`
  ).run(newContent, existing.content, newImportance, embBlob, now, id, userId);

  return db.prepare("SELECT * FROM user_memories WHERE id = ?").get(id) as Memory;
}

export function deleteMemory(userId: string, id: string): boolean {
  const result = db.prepare("DELETE FROM user_memories WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export function deleteAllMemories(userId: string, type?: string): number {
  if (type) {
    const result = db.prepare("DELETE FROM user_memories WHERE user_id = ? AND memory_type = ?").run(userId, type);
    return result.changes;
  }
  const result = db.prepare("DELETE FROM user_memories WHERE user_id = ?").run(userId);
  return result.changes;
}
