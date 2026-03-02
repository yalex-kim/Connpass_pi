# TRD — IntelliSearch
> Technical Requirements Document
> 작성: 2026-02-28

---

## 1. 시스템 구성

```
[브라우저 — Vanilla JS]
    ↕ WebSocket (ws://localhost:3000)
[Node.js 서버 — server/index.ts]
    ├── pi-agent-core Agent loop
    ├── 번역 모드: pi-ai streamSimple() 직통
    └── ↕ HTTP (http://localhost:5000)
[Flask API — api/app.py]
    ├── /api/rag/*
    ├── /api/jira/*
    ├── /api/mcp/*
    ├── /api/skills/*
    └── /api/sessions/*
         ↕
[사내 인프라]
    ├── vLLM (http://vllm.internal/v1)
    ├── RAGaaS (http://ragaas.internal)
    ├── Jira MCP SSE
    └── Gerrit MCP SSE
```

---

## 2. WebSocket 프로토콜

### 클라이언트 → 서버

```typescript
// 일반 채팅
{
  type: "chat",
  sessionId: string,
  message: string,
  config: {
    model: "GLM4.7" | "Kimi-K2.5" | "GPT-OSS-120B",
    indexes: string[],         // 활성화된 RAG 인덱스
    tools: string[],           // 활성화된 tool 목록
    temperature: number,
    maxTokens: number,
    maxToolSteps: number,
    thinkingMode: "off" | "minimal" | "low" | "medium" | "high",
  }
}

// 번역 모드
{
  type: "translate",
  sessionId: string,
  text: string,
  config: {
    model: "GLM4.7" | "Kimi-K2.5" | "GPT-OSS-120B",
    targetLang: "KO" | "EN" | "JA" | "ZH",
    translatePrompt: string,   // 커스텀 프롬프트 (설정에서)
  }
}

// Stop
{ type: "stop", sessionId: string }

// 세션 목록 요청
{ type: "sessions.list" }

// 세션 삭제
{ type: "sessions.delete", sessionId: string }
```

### 서버 → 클라이언트

```typescript
// 스트리밍 토큰
{ type: "token", sessionId: string, delta: string }

// tool 시작
{
  type: "tool_start",
  sessionId: string,
  toolCallId: string,
  toolName: string,
  toolLabel: string,
  params: Record<string, unknown>
}

// tool 완료
{
  type: "tool_end",
  sessionId: string,
  toolCallId: string,
  toolName: string,
  details: Record<string, unknown>  // UI용 메타 (출처, 이슈 수 등)
}

// Agent 완료
{ type: "agent_end", sessionId: string, totalTokens: number }

// 컴팩션 발생
{ type: "compaction", sessionId: string, message: string }

// 에러
{ type: "error", sessionId: string, message: string, code: string }

// 세션 목록 응답
{ type: "sessions.list", sessions: Session[] }
```

---

## 3. Node.js 서버 — Agent 설정

### 3.1 일반 채팅 모드

```typescript
// server/agent.ts
import { Agent } from "@mariozechner/pi-agent-core";
import { models } from "./models";
import { ragTool, jiraTool, gerritTool, mcpTool } from "./tools";

export async function createAgent(sessionId: string, config: ChatConfig) {
  const agent = new Agent({
    model: models[config.model],
    systemPrompt: buildSystemPrompt(sessionId), // Agent.md 포함
    tools: buildTools(config),                  // 활성 tool만
    maxIterations: config.maxToolSteps,
    onEvent: (event) => emitToClient(sessionId, event),
  });
  return agent;
}

function buildTools(config: ChatConfig): AgentTool[] {
  const tools: AgentTool[] = [];
  if (config.tools.includes("rag"))    tools.push(ragTool(config.indexes));
  if (config.tools.includes("jira"))   tools.push(jiraTool());
  if (config.tools.includes("gerrit")) tools.push(gerritTool());
  // MCP tools: 세션 시작 시 동적 추가
  return tools;
}
```

### 3.2 번역 모드 — tool 없이 LLM 직통

```typescript
// server/translate.ts
import { streamSimple } from "@mariozechner/pi-ai";
import { models } from "./models";

export async function translateDirect(
  ws: WebSocket,
  sessionId: string,
  text: string,
  config: TranslateConfig,
  signal: AbortSignal
) {
  // tool 등록 없이 streamSimple 직접 호출
  // tool_choice: none 효과 — 라이브러리 수준에서 tool 자체가 없음
  const stream = streamSimple(
    models[config.model],
    {
      system: buildTranslatePrompt(config),
      messages: [{ role: "user", content: text }],
    },
    { signal }
  );

  for await (const event of stream) {
    if (event.type === "delta") {
      ws.send(JSON.stringify({ type: "token", sessionId, delta: event.text }));
    }
  }
  ws.send(JSON.stringify({ type: "agent_end", sessionId }));
}

function buildTranslatePrompt(config: TranslateConfig): string {
  return config.translatePrompt
    .replace("{{target_lang}}", config.targetLang)
    .replace("{{formality}}", "formal");
}
```

---

## 4. Flask API 엔드포인트

### 4.1 RAG

```
POST /api/rag/search
Body: { query: string, indexes: string[], topK?: number }
Resp: { results: [{ content, source, score, indexId }] }

GET  /api/rag/indexes
Resp: { indexes: IndexMeta[] }
```

### 4.2 Jira

```
GET  /api/jira/issue/:issueKey
GET  /api/jira/search?jql=...&maxResults=...
POST /api/jira/issue/:issueKey/comment
Body: { body: string }
```

### 4.3 MCP

```
GET  /api/mcp/servers          → 등록된 MCP 서버 목록
POST /api/mcp/servers          → MCP 서버 등록
DELETE /api/mcp/servers/:id    → 삭제
POST /api/mcp/servers/:id/test → 연결 테스트 (tools/list 호출)
POST /api/mcp/call             → tool 실행
Body: { serverId, toolName, params }
```

### 4.4 Skills

```
GET    /api/skills             → Skill 목록
POST   /api/skills             → Skill 등록 (SKILL.md content)
PUT    /api/skills/:id
DELETE /api/skills/:id
POST   /api/skills/:id/run     → 수동 실행
```

### 4.5 Sessions

```
GET  /api/sessions             → 세션 목록
POST /api/sessions             → 새 세션 생성
GET  /api/sessions/:id         → 세션 상세 (메시지 이력)
DELETE /api/sessions/:id
POST /api/sessions/:id/upload  → 파일 업로드 (임시 RAG)
```

---

## 5. SQLite 스키마

```sql
-- 세션
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT DEFAULT 'default',
  title       TEXT,
  persona     TEXT DEFAULT 'BT',
  model       TEXT DEFAULT 'GLM4.7',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 메시지 (append-only, JSONL 방식으로 파일 저장도 병행)
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  role        TEXT NOT NULL,  -- user | assistant | tool
  content     TEXT NOT NULL,  -- JSON
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- MCP 서버
CREATE TABLE mcp_servers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT DEFAULT 'default',
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  headers     TEXT,           -- JSON
  enabled     BOOLEAN DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Skills
CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  user_id     TEXT DEFAULT 'default',
  name        TEXT NOT NULL,
  description TEXT,
  content     TEXT NOT NULL,  -- SKILL.md 전체
  tools       TEXT,           -- JSON array
  indexes     TEXT,           -- JSON array
  persona     TEXT,           -- JSON array
  enabled     BOOLEAN DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Cron Jobs
CREATE TABLE cron_jobs (
  id            TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL REFERENCES skills(id),
  user_id       TEXT DEFAULT 'default',
  schedule      TEXT NOT NULL,   -- cron expression
  notify_type   TEXT,            -- session | email | webhook
  notify_target TEXT,
  last_run      DATETIME,
  enabled       BOOLEAN DEFAULT 1
);

-- 사용량 로그
CREATE TABLE usage_logs (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  user_id      TEXT DEFAULT 'default',
  model        TEXT,
  mode         TEXT,            -- chat | translate
  input_tokens  INTEGER,
  output_tokens INTEGER,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 설정
CREATE TABLE user_settings (
  user_id         TEXT PRIMARY KEY DEFAULT 'default',
  agent_md        TEXT,          -- Agent.md 내용
  default_model   TEXT DEFAULT 'GLM4.7',
  translate_model TEXT DEFAULT 'Kimi-K2.5',
  translate_lang  TEXT DEFAULT 'KO',
  translate_prompt TEXT,
  ui_settings     TEXT           -- JSON (테마, 폰트 등)
);
```

---

## 6. MCP 연동 상세

### 세션 시작 시 tool 등록 흐름

```typescript
// server/tools/mcp.ts
async function loadMcpTools(serverId: string): Promise<AgentTool[]> {
  // 1. Flask에서 서버 정보 조회
  const server = await fetchFlask(`/api/mcp/servers/${serverId}`);

  // 2. SSE 연결 후 tools/list 호출
  const toolsList = await fetch(`${server.url}/tools/list`, {
    headers: server.headers ?? {}
  }).then(r => r.json());

  // 3. 각 MCP tool을 AgentTool로 래핑
  return toolsList.tools.map(mcpTool => ({
    name: `mcp_${server.id}_${mcpTool.name}`,
    label: `[MCP:${server.name}] ${mcpTool.name}`,
    description: mcpTool.description,
    parameters: mcpSchemaToTypeBox(mcpTool.inputSchema),
    execute: async (toolCallId, params, signal) => {
      const result = await fetchFlask("/api/mcp/call", {
        method: "POST",
        body: { serverId: server.id, toolName: mcpTool.name, params }
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  }));
}
```

---

## 7. 임시 RAG (세션 내 파일)

```
파일 업로드 → Flask /api/sessions/:id/upload
→ 텍스트 추출 (pymupdf / python-pptx / python-docx)
→ 토큰 수 측정
   ├── ≤ 8K tokens: 컨텍스트에 직접 추가
   └── > 8K tokens: 청크 분할
       → 사내 임베딩 API 벡터화
       → 세션 메모리 저장 (dict, TTL=세션 종료)
       → search_document tool 등록 후 Node.js에 알림
```

---

## 8. 번역 모드 시스템 프롬프트 기본값

```
You are a professional translator.
- Detect the source language automatically
- Translate to: {{target_lang}}
- Output ONLY the translated text, no explanations, no preamble
- Preserve all formatting: markdown, code blocks, line breaks, bullet points
- For BT/WiFi technical terms (HCI error codes, spec references, command names),
  keep the original English unless a standard Korean translation exists
- Korean style: formal (합쇼체)
```

---

## 9. 에러 처리 원칙

| 상황 | 처리 |
|------|------|
| vLLM 연결 실패 | WS error 이벤트 + UI 토스트 |
| RAG 타임아웃 | tool 결과에 에러 텍스트, Agent가 판단 후 계속 |
| MCP tool 실패 | tool 결과에 에러 포함, Agent 루프 계속 |
| Stop 버튼 | AbortController.abort() → 스트리밍 중단, 부분 응답 저장 |
| 컨텍스트 초과 | pi-agent-core 자동 컴팩션, WS compaction 이벤트 |

---

## 10. 개발 환경 설정

```bash
# 전체 설치
cd server && npm install
cd api && pip install -r requirements.txt

# 개발 실행 (동시)
npm run dev          # Node.js (tsx watch)
python api/app.py    # Flask (debug mode)
# 브라우저에서 frontend/index.html 열기 (Live Server 또는 직접)

# 환경 변수
cp .env.example .env
# .env에 vLLM, RAGaaS, Jira, Gerrit URL 설정
```
