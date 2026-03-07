# Plan: LLM 프롬프트 개선 + 사용자 장기기억 설계

> 작성일: 2026-03-07
> 브랜치: claude/llm-prompts-user-memory-obG7m

---

## 0. 컨텍스트 관리 현황 요약 (개선 전 파악)

### 현재 문제
1. **컴팩션 미구현**: 세션 전체 히스토리를 매 턴마다 LLM에 전송 → Kimi-K2.5(32K) 기준 긴 세션에서 한도 초과 위험
2. **System prompt 구성**: 기본지시 + Jira서버 + agent.md + Skills → 컴팩션 시에도 이 부분은 항상 보존
3. **agent.md 인젝션 위험**: `---` 구분자 기반이라 사용자 입력으로 구조 교란 가능
4. **모델 설정 캐시 없음**: 매 채팅 턴마다 `resolveModel()` → SQLite 조회
5. **프롬프트 디버깅 불가**: 실제 전달 프롬프트 추적 수단 없음

### 컴팩션과 장기기억의 관계
```
[세션 내]                        [세션 간]
System Prompt (항상 보존)
 └─ base instruction
 └─ Jira servers
 └─ agent.md (커스텀 지시)  ←── 사용자 설정 (수동 관리)
 └─ Skills
 └─ [장기기억 주입 섹션]    ←── 장기기억 DB (자동 관리) ★신규

Message History (컴팩션 대상)
 └─ user/assistant turns     →→→ 세션 종료 시 기억 추출 ★신규
 └─ tool results (임베딩됨)
```

**핵심 인사이트**: agent.md는 system prompt 내에 있어 컴팩션에 영향 없음.
반면 세션 내 대화는 컴팩션/세션 종료로 유실될 수 있음 → 장기기억이 이를 보완.

---

## 1. 프롬프트 파이프라인 개선 (Part 1)

### 1-A. agent.md 인젝션 방어

**파일**: `server/agent.ts` — `buildSystemPrompt()` 1줄 수정

```typescript
// 변경 전:
${agentMd ? `\n---\n사용자 커스텀 지시사항:\n${agentMd}` : ""}

// 변경 후 (XML 태그로 펜싱):
${agentMd ? `\n<user_instructions>\n${agentMd}\n</user_instructions>` : ""}
```

---

### 1-B. 모델 설정 캐싱

**파일**: `server/models.ts`

```typescript
const _cache = new Map<string, { resolved: ResolvedModelConfig; at: number }>();
const TTL = 60_000;

export function invalidateModelCache(modelId?: string) {
  modelId ? _cache.delete(modelId) : _cache.clear();
}

// resolveModel() 함수 최상단에:
const hit = _cache.get(modelId);
if (hit && Date.now() - hit.at < TTL) return hit.resolved;
// ... DB 조회 ...
_cache.set(modelId, { resolved, at: Date.now() });
```

**파일**: `server/routes/settings.ts` — PUT/DELETE `/llm-configs/:model_id` 에서 `invalidateModelCache(model_id)` 호출

---

### 1-C. 컨텍스트 윈도우 가드 (토큰 트리밍)

**파일**: `server/index.ts` — 새 헬퍼 함수 추가

컴팩션이 없는 상태에서 임시 대응. chars/4로 토큰 추정, 60% 초과 시 오래된 메시지 제거.

```typescript
function trimHistory(history: AgentMessage[], contextWindow: number): AgentMessage[] {
  const budget = Math.floor(contextWindow * 0.60);
  let est = 0;
  const kept: AgentMessage[] = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = Math.ceil(JSON.stringify(history[i]).length / 4);
    if (est + tokens > budget && kept.length > 0) {
      kept.unshift({
        role: "user",
        content: `[이전 대화 ${history.length - kept.length}개 메시지가 컨텍스트 한도로 생략됨]`,
        timestamp: Date.now(),
      } as AgentMessage);
      break;
    }
    est += tokens;
    kept.unshift(history[i]);
  }
  return kept;
}
```

`createAgent()`가 `{ agent, contextWindow }` 튜플 반환하도록 수정.

---

### 1-D. 프롬프트 디버그 로그

**파일**: `server/schema.sql` — 테이블 추가

```sql
CREATE TABLE IF NOT EXISTS prompt_logs (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    model          TEXT NOT NULL,
    system_prompt  TEXT NOT NULL,
    message_count  INTEGER NOT NULL DEFAULT 0,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_logs_session ON prompt_logs(session_id);
```

`agent.prompt()` 직전 fire-and-forget으로 삽입. 실패해도 채팅 블로킹 없음.

---

### 1-E. 지능적 RAG 인덱스 선택

**파일**: `server/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS rag_index_metadata (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    domain      TEXT NOT NULL DEFAULT '[]',   -- JSON: ["BT","WiFi","공통"]
    type        TEXT NOT NULL DEFAULT 'spec', -- spec|requirement|confluence|jira|gerrit
    version     TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO rag_index_metadata (id, name, description, domain, type) VALUES
  ('bt-spec',    'BT Spec',    'Bluetooth Core Spec — HCI 커맨드, 에러코드, 프로토콜',         '["BT"]',            'spec'),
  ('wifi-spec',  'WiFi Spec',  '802.11 스펙 — MAC, PHY, 보안 프로토콜',                       '["WiFi"]',          'spec'),
  ('jira-bt',    'Jira BT',   'BT 프로젝트 이슈 — 버그, 기능, RCA',                           '["BT"]',            'jira'),
  ('jira-wifi',  'Jira WiFi', 'WiFi 프로젝트 이슈',                                            '["WiFi"]',          'jira'),
  ('gerrit',     'Gerrit',    '코드 변경사항 — 커밋, diff, 리뷰 코멘트',                        '["BT","WiFi","공통"]','gerrit'),
  ('confluence', 'Confluence','팀 위키 — 절차, 온보딩, 회의록',                                 '["BT","WiFi","공통"]','confluence');
```

**파일**: `server/tools/rag.ts` — `listRagIndexesTool()` 추가 export

```typescript
export function listRagIndexesTool(): AgentTool {
  return {
    name: "list_rag_indexes",
    label: "RAG 인덱스 목록",
    description: `사용 가능한 RAG 인덱스 목록을 반환합니다.
rag_search 호출 전에 먼저 이 tool로 적합한 인덱스를 확인하고
질문과 관련 있는 2~3개 인덱스만 선택해 검색하세요.`,
    parameters: Type.Object({}),
    execute: async () => {
      const rows = db.prepare(
        "SELECT id, name, description, domain, type, version FROM rag_index_metadata WHERE enabled=1"
      ).all() as any[];
      const text = rows.map(r => {
        const domain = JSON.parse(r.domain || "[]").join("/");
        return `- "${r.id}" [${domain}] ${r.name}: ${r.description}`;
      }).join("\n");
      return { content: [{ type: "text", text }], details: { count: rows.length } };
    },
  };
}
```

---

## 2. 사용자 장기기억 설계 (Part 2)

### 2-A. 기억의 두 종류

#### Type 1: 선호/취향 (Preference)
사용자의 개인 특성. 천천히 변하며 모든 대화에 적용됨.

| 예시 | category |
|------|----------|
| "한국어로 답변, 영어 기술용어는 유지" | `preference` |
| "GLM4.7 모델 선호" | `preference` |
| "답변은 간결하게, 코드는 TypeScript" | `preference` |
| "WiFi 팀 소속, 주로 802.11ax 담당" | `preference` |

**특징**: 하나의 주제에 대해 단 하나의 최신 값만 유지. 업데이트 필요.

#### Type 2: 업무 이력 (Work History)
특정 이슈/피쳐/기기에 대한 작업 기록. 시간이 지나면 내용이 바뀜.

| 예시 | category |
|------|----------|
| "BT-1234: QCC5171 sniff mode timeout 이슈 — 조사 중" | `issue` |
| "BT-1234: QCC5171 sniff mode timeout 이슈 — 해결됨 (패치 BT-5.4.2)" | `issue` (업데이트) |
| "WiFi AP 호환성 테스트 — Cisco Meraki MX 진행 중" | `project` |
| "A2DP sink 구현 — 완료, main 브랜치 머지됨" | `feature` |

**특징**: `key` (이슈번호, 피쳐명)로 식별. 같은 key의 새 내용 → 기존 기억 업데이트.

---

### 2-B. DB 스키마

**파일**: `server/schema.sql`

```sql
-- 사용자 장기기억
CREATE TABLE IF NOT EXISTS user_memories (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,

    -- 기억 분류
    memory_type     TEXT NOT NULL DEFAULT 'preference',
                    -- 'preference' | 'issue' | 'project' | 'feature' | 'fact'
    topic_key       TEXT,
                    -- Type 2 전용: 동일 주제 식별자 (예: "BT-1234", "A2DP sink 구현")
                    -- NULL이면 Type 1 (선호)
                    -- 같은 user_id + topic_key → 업데이트 대상

    -- 내용
    content         TEXT NOT NULL,    -- 현재 기억 내용 (자연어)
    prev_content    TEXT,             -- 이전 내용 백업 (1단계만 보존)
    importance      INTEGER NOT NULL DEFAULT 3,  -- 1(낮음)~5(높음)

    -- 벡터
    embedding       BLOB,             -- Float32Array 직렬화, NULL 허용

    -- 출처 및 통계
    source_session  TEXT,             -- 가장 최근 업데이트 session_id
    access_count    INTEGER NOT NULL DEFAULT 0,
    last_accessed   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_memories_user   ON user_memories(user_id);
CREATE INDEX IF NOT EXISTS idx_user_memories_type   ON user_memories(user_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_user_memories_topic  ON user_memories(user_id, topic_key)
    WHERE topic_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_memories_imp    ON user_memories(user_id, importance DESC);

-- UNIQUE 제약: 같은 user_id + topic_key는 하나만 (Type 2 업데이트 보장)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_memories_unique_topic
    ON user_memories(user_id, topic_key) WHERE topic_key IS NOT NULL;

-- 세션별 기억 추출 추적
CREATE TABLE IF NOT EXISTS memory_extractions (
    session_id      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed
    memories_upserted INTEGER NOT NULL DEFAULT 0,
    attempted_at    TEXT,
    completed_at    TEXT
);
```

**설계 핵심**:
- `topic_key`가 있으면 Type 2 (업무 이력) → `UPSERT`로 처리
- `topic_key`가 NULL이면 Type 1 (선호) → 유사도 검색으로 중복 감지 후 UPDATE
- `prev_content`: 이전 내용 1단계 보존 → 사용자가 되돌리기 가능

---

### 2-C. 신규 파일: server/memory.ts

#### 구조

```typescript
// ── 임베딩 & 유사도 ─────────────────────────────────────
async function getEmbedding(text: string): Promise<Float32Array | null>
function cosineSimilarity(a: Float32Array, b: Float32Array): number

// ── 기억 조회 (세션 시작 시 호출) ─────────────────────────
export async function retrieveRelevantMemories(
  userId: string,
  sessionContext: string,  // 첫 메시지 또는 세션 제목
  topK = 8
): Promise<string>  // <user_long_term_memory>...</user_long_term_memory> 반환

// ── 기억 추출 (세션 종료 후 background) ───────────────────
export async function extractMemoriesFromSession(
  sessionId: string,
  userId: string
): Promise<void>

// ── 단건 CRUD (API에서 호출) ──────────────────────────────
export function listMemories(userId: string, type?: string): Memory[]
export function upsertMemory(userId: string, data: MemoryInput): Memory
export function updateMemory(userId: string, id: string, data: Partial<MemoryInput>): void
export function deleteMemory(userId: string, id: string): void
export function deleteAllMemories(userId: string): void
```

#### 임베딩 (vLLM `/v1/embeddings` + 키워드 폴백)

```typescript
const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";

async function getEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${VLLM_BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: [{ embedding: number[] }] };
    return new Float32Array(data.data[0].embedding);
  } catch {
    return null;  // 실패 시 폴백: 중요도 순 정렬로 대체
  }
}
```

#### 기억 조회 — 세션 시작 시 호출

프롬프트 주입 형식:
```
<user_long_term_memory>
[preference] 한국어 답변, 영어 기술용어 유지 선호
[preference] 주로 BT 5.4 인증 테스트 담당, QCC5171 칩셋
[issue] BT-1234: sniff mode에서 HCI_ERR_CONNECTION_TIMEOUT 반복 — 해결됨 (패치 v5.4.2)
[project] WiFi AP 호환성 테스트 — Cisco Meraki MX 진행 중
</user_long_term_memory>
```

- Type 1 (preference): 항상 포함 (최대 5개)
- Type 2 (issue/project/feature): 세션 컨텍스트와 유사도 기반 상위 5개

#### 기억 추출 — LLM 호출 프롬프트

```
다음 대화에서 사용자에 대해 기억할 만한 정보를 추출하세요.

규칙:
- preference: 선호/취향/작업 방식 (반복 적용되는 것)
- issue: Jira 이슈나 버그 (topic_key = 이슈 번호, 예: "BT-1234")
- project: 담당 프로젝트/테스트 (topic_key = 프로젝트명)
- feature: 구현 중인 기능 (topic_key = 기능명)
- fact: 중요 사실 (기기 모델, 펌웨어 버전 등)

JSON 배열로만 응답하세요:
[
  {
    "content": "기억 내용",
    "memory_type": "preference|issue|project|feature|fact",
    "topic_key": "이슈번호 또는 주제명 (Type 2만, 없으면 null)",
    "importance": 1-5
  }
]

일상적 질문만 있거나 기억할 내용 없으면 [] 반환.
```

#### UPSERT 로직 (중복 방지)

```typescript
async function upsertExtractedMemory(userId: string, extracted: ExtractedMemory, sessionId: string) {
  if (extracted.topic_key) {
    // Type 2: topic_key 기준 UPSERT
    const existing = db.prepare(
      "SELECT id, content FROM user_memories WHERE user_id=? AND topic_key=?"
    ).get(userId, extracted.topic_key) as Memory | undefined;

    if (existing) {
      // 이전 내용 백업하고 업데이트
      db.prepare(`
        UPDATE user_memories
        SET content=?, prev_content=?, importance=?, embedding=?,
            source_session=?, updated_at=?
        WHERE id=?
      `).run(extracted.content, existing.content, extracted.importance,
             embedding ? Buffer.from(embedding.buffer) : null,
             sessionId, new Date().toISOString(), existing.id);
    } else {
      // 신규 삽입
      db.prepare(`INSERT INTO user_memories (...) VALUES (...)`).run(...);
    }
  } else {
    // Type 1 (preference): 유사도 0.88 이상이면 기존 업데이트, 아니면 신규 삽입
    const allPrefs = db.prepare(
      "SELECT id, content, embedding FROM user_memories WHERE user_id=? AND memory_type='preference'"
    ).all(userId) as Memory[];

    if (embedding) {
      const duplicate = allPrefs.find(m => {
        if (!m.embedding) return false;
        return cosineSimilarity(embedding, blobToFloat32(m.embedding)) >= 0.88;
      });
      if (duplicate) {
        db.prepare(`UPDATE user_memories SET content=?, prev_content=?, updated_at=? WHERE id=?`)
          .run(extracted.content, duplicate.content, new Date().toISOString(), duplicate.id);
        return;
      }
    }
    // 신규 삽입
    db.prepare(`INSERT INTO user_memories (...) VALUES (...)`).run(...);
  }
}
```

---

### 2-D. buildSystemPrompt 통합

**파일**: `server/agent.ts` — `buildSystemPrompt` async화 + 기억 주입

```typescript
export async function buildSystemPrompt(sessionId: string, userId: string): Promise<string> {
  // ... 기존 agentMd, jiraServers, skills 로드 ...

  // 세션 컨텍스트 (제목 or 빈 문자열)
  const session = db.prepare("SELECT title FROM sessions WHERE id=?").get(sessionId) as { title?: string } | undefined;
  const sessionContext = session?.title ?? "";

  // 장기기억 조회 (실패해도 빈 문자열 반환 — 채팅 블로킹 없음)
  const memorySection = await retrieveRelevantMemories(userId, sessionContext).catch(() => "");

  return `${basePrompt}${jiraSection}${memorySection}${agentMd ? `\n<user_instructions>\n${agentMd}\n</user_instructions>` : ""}${skillsSection}`;
}
```

**완성된 system prompt 구조:**
```
[기본 역할 지시]
[Jira 서버 목록]
<user_long_term_memory>
[preference] ...
[issue] ...
</user_long_term_memory>
<user_instructions>
{agent.md 내용}
</user_instructions>
[Skills 섹션]
```

---

### 2-E. 세션 종료 후 기억 추출 트리거

**파일**: `server/index.ts` — `agent.prompt()` 완료 후

```typescript
await agent.prompt(message);

// 기억 추출 — fire-and-forget, 채팅 응답 블로킹 없음
extractMemoriesFromSession(sessionId, userId).catch(err =>
  console.error(`[memory] extraction failed for session ${sessionId}:`, err)
);
```

---

### 2-F. 기억 관리 REST API

**파일**: `server/routes/memories.ts` (신규)

```
GET    /api/memories
       ?type=preference|issue|project|feature|fact
       &limit=50&offset=0
       → { memories: Memory[], total: number }

GET    /api/memories/:id
       → Memory (prev_content 포함)

POST   /api/memories
       body: { content, memory_type, topic_key?, importance? }
       → Memory (수동 추가)

PUT    /api/memories/:id
       body: { content?, importance? }
       → Memory (사용자가 직접 수정)

DELETE /api/memories/:id
       → 204

DELETE /api/memories
       ?type=...  (type 지정 시 해당 타입만, 없으면 전체)
       → { deleted: number }
```

모든 엔드포인트: `X-User-Id` 헤더로 사용자 격리.

---

### 2-G. 설정 UI — 기억 관리 탭

**파일**: `frontend/index.html`, `frontend/js/settings.js`

기존 설정 패널 내 "기억" 탭 추가:

```
┌─ 설정 ───────────────────────────────────────────────┐
│ [일반] [LLM] [MCP] [Jira] [Gerrit] [스킬] [기억] ←신규 │
├──────────────────────────────────────────────────────┤
│ ● 선호/취향                              [+ 추가]    │
│ ┌────────────────────────────────────────────────┐  │
│ │ [preference] 한국어 답변, 영어 기술용어 유지    │  │
│ │ 중요도: ★★★★☆  2026-03-01          [수정][삭제] │  │
│ │ [preference] GLM4.7 모델 선호                  │  │
│ │ 중요도: ★★★☆☆  2026-02-28          [수정][삭제] │  │
│ └────────────────────────────────────────────────┘  │
│                                                      │
│ ● 업무 이력                                          │
│ [전체] [issue] [project] [feature] [fact]            │
│ ┌────────────────────────────────────────────────┐  │
│ │ [issue] BT-1234: sniff mode timeout — 해결됨   │  │
│ │ key: BT-1234  중요도: ★★★★★  2026-03-05 [수정][삭제] │
│ │                                                │  │
│ │ [project] WiFi AP 호환성 테스트 (Meraki MX)    │  │
│ │ key: wifi-ap-test  중요도: ★★★☆☆ 2026-03-04 [수정][삭제] │
│ └────────────────────────────────────────────────┘  │
│                                    [전체 삭제]       │
└──────────────────────────────────────────────────────┘
```

**수정 UI**: 인라인 텍스트 편집 또는 모달. 이전 내용(`prev_content`) 확인 링크 제공.

---

## 3. 수정/신규 파일 목록

| 파일 | 유형 | 변경 내용 |
|------|------|----------|
| `server/schema.sql` | 수정 | `prompt_logs`, `rag_index_metadata`, `user_memories`, `memory_extractions` 테이블 추가 |
| `server/agent.ts` | 수정 | agent_md XML 펜싱, `buildSystemPrompt` async화 + 기억 주입, `createAgent` 반환 타입 변경 |
| `server/models.ts` | 수정 | TTL 캐시 + `invalidateModelCache` 추가 |
| `server/index.ts` | 수정 | `trimHistory()`, 프롬프트 로그, 기억 추출 트리거 |
| `server/tools/rag.ts` | 수정 | `listRagIndexesTool()` 추가 |
| `server/routes/settings.ts` | 수정 | 모델 캐시 무효화 호출 |
| `server/memory.ts` | **신규** | 임베딩, 코사인 유사도, 기억 CRUD, 추출 로직 전체 |
| `server/routes/memories.ts` | **신규** | 기억 관리 REST API |
| `frontend/index.html` | 수정 | 기억 탭 HTML |
| `frontend/js/settings.js` | 수정 | 기억 탭 UI 로직 |
| `docs/context-management.md` | **신규** | 컨텍스트 관리 문서 |

---

## 4. 구현 순서

```
1. server/schema.sql           — 테이블 DDL (모든 변경의 기반)
2. server/models.ts            — 캐시 (독립적, 안전)
3. server/agent.ts (1/2)       — agent_md XML 펜싱만 (1줄, 즉시 효과)
4. server/tools/rag.ts         — listRagIndexesTool 추가
5. server/memory.ts            — 장기기억 모듈 (핵심)
6. server/routes/memories.ts   — 기억 API
7. server/index.ts             — trimHistory + 로그 + 기억 트리거
8. server/agent.ts (2/2)       — buildSystemPrompt async + 기억 주입
9. server/routes/settings.ts   — 캐시 무효화
10. frontend/                  — 기억 관리 UI
```

---

## 5. 검증 체크리스트

### 프롬프트 개선
- [ ] agent.md에 `---` 입력 후 `prompt_logs`에서 시스템 프롬프트 구조 확인
- [ ] 50개 이상 메시지 세션에서 sentinel 메시지 삽입 확인
- [ ] 모델 설정 변경 없이 연속 10회 채팅 → DB 조회 1회만 발생
- [ ] `GET /api/admin/prompt-logs?session_id=xxx`로 실제 프롬프트 조회

### 장기기억
- [ ] 첫 세션 "GLM4.7 선호해" → `user_memories`에 preference 추가
- [ ] "BT-1234 이슈 해결됨" → 기존 BT-1234 memory 업데이트, `prev_content` 보존
- [ ] 새 세션 시작 → system prompt에 `<user_long_term_memory>` 포함
- [ ] vLLM 임베딩 엔드포인트 오프라인 → 기억 추출 실패해도 채팅 정상 동작
- [ ] `/api/memories` 목록 → 기억 조회, 수정, 삭제 동작
- [ ] UI 기억 탭에서 type별 필터링, 수정, 삭제 동작
