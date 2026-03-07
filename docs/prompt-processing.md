# Connpass — 프롬프트 처리 흐름

> 작성 기준: 2026-03-07
> 대상 파일: `frontend/js/app.js`, `server/index.ts`, `server/agent.ts`, `server/tools/rag.ts`, `server/tools/mcp.ts`, `frontend/js/chat.js`

---

## 1. 전체 아키텍처 요약

```
[브라우저]
  sendMessage()
      │ WebSocket (type: "chat")
      ▼
[index.ts — WS 핸들러]
  createAgent() → agent.prompt()
      │ pi-agent-core 루프
      ├─ LLM 스트리밍 → thinking/token 이벤트
      ├─ tool 실행   → tool_start/tool_end 이벤트
      └─ 완료        → agent_end 이벤트
      │ WebSocket 이벤트 브로드캐스트
      ▼
[브라우저]
  handleWsMessage()
      │ 블록 타입별 분기
      ▼
[ChatRenderer — 블록 기반 렌더링]
  thinking block / text block / tool_call block
```

---

## 2. WS 연결 초기화

**파일**: `frontend/js/app.js → connectWS()`, `server/index.ts → wss.on("connection")`

```
브라우저 WS 연결
    │
    ├─ 브라우저: sessions.list 전송 → 사이드바 세션 목록 복원
    │
    └─ 서버: 모델 헬스체크 비동기 실행
           llm_model_configs에서 모델 목록 조회
           각 모델 base_url/models 엔드포인트 3초 timeout으로 병렬 호출
           결과 → WS type: "model_health" 전송
           브라우저: 오프라인 모델 카드에 .offline 클래스 적용
```

---

## 3. 채팅 메시지 처리 흐름 (일반 모드)

### 3-1. 브라우저 → 서버

**파일**: `frontend/js/app.js → sendMessage()`

```
사용자 입력 (Enter / 버튼)
    │
    ├─ 검증: isGenerating 또는 WS 연결 확인
    ├─ 세션 없으면 POST /api/sessions 로 신규 생성
    ├─ setGenerating(true)
    ├─ ChatRenderer.addUserBlock() — 사용자 메시지 즉시 렌더링
    ├─ state 초기화:
    │     currentTurnId = 새 ID
    │     currentTextBlockId = null  (첫 token 도착 시 lazy 생성)
    │     currentThinkingBlockId = null
    │     lastEventWasToolCall = false
    └─ WS 전송:
        {
          type: "chat",
          sessionId,
          message: text,
          config: {
            model, indexes, tools,
            temperature, maxTokens, maxToolSteps, thinkingMode
          }
        }
```

### 3-2. 서버 WS 핸들러

**파일**: `server/index.ts → ws.on("message") → type === "chat"`

```
WS 수신
    │
    ├─ userId = req.headers["x-user-id"] ?? "default"
    ├─ 기존 세션 abort (동일 sessionId 중복 요청 방어)
    ├─ assistantMsgId = crypto.randomUUID()  ← tool_calls FK용
    ├─ createAgent(ws, sessionId, config, userId, assistantMsgId)
    ├─ sessions.set(sessionId, { agent, controller })
    ├─ loadHistory(sessionId) → agent.replaceMessages(history)
    ├─ saveMessage(sessionId, "user", message)         ← DB 저장
    ├─ UPDATE sessions SET generating = 1
    │
    ├─ await agent.prompt(message)                     ← Agent 루프 시작
    │       └─ (이벤트 스트리밍, 아래 섹션 참조)
    │
    ├─ 완료 후:
    │     saveMessage(sessionId, "assistant", lastMsg, assistantMsgId)
    │     첫 대화이면: generateTitle() — fire-and-forget (비동기, generating=0 블록 안 함)
    │
    └─ finally:
          UPDATE sessions SET generating = 0
          sessions.delete(sessionId)
```

### 3-3. Agent 생성 및 설정

**파일**: `server/agent.ts → createAgent()`

```
모델 결정
    ├─ OpenAI 모델 (gpt-*): models[] 정적 참조
    └─ vLLM 모델: resolveModel() — DB llm_model_configs에서 동적 로드
                   (base_url, temperature, apiKey, max_tokens)

maxTokens 오버라이드 (config.maxTokens > 0이면 적용)
    model = { ...model, maxTokens: config.maxTokens }

시스템 프롬프트 구성 (buildSystemPrompt)
    ├─ 기본: BT/WiFi 어시스턴트 소개 + 후속 액션 지시
    ├─ Jira 서버 목록 (enabled=1인 서버)
    ├─ 사용자 커스텀 지시사항 (user_settings.agent_md)
    └─ 스킬 목록 (skills/ + skills-user/<userId>/)

Tool 목록 구성
    ├─ config.tools.includes("rag") → ragTool(activeIndexes)
    └─ loadAllMcpTools(userId) — 등록된 MCP 서버 전체 동적 로드

Agent 초기화
    new Agent({
      initialState: { systemPrompt, model, tools, thinkingLevel },
      streamFn: streamFnWithConfig   ← temperature + apiKey 주입 래퍼
    })
```

### 3-4. Agent 루프 이벤트 → WS 브로드캐스트

**파일**: `server/agent.ts → agent.subscribe()`

| 이벤트 | WS 전송 | DB 처리 |
|--------|---------|---------|
| `message_update` / `thinking_delta` | `{ type:"thinking", delta }` | — |
| `message_update` / `text_delta` | `{ type:"token", delta }` | — |
| `tool_execution_start` | `{ type:"tool_start", toolCallId, toolName, toolLabel, params }` | INSERT tool_calls |
| `tool_execution_end` | `{ type:"tool_end", toolCallId, toolName, details }` | UPDATE tool_calls |
| `agent_end` | `{ type:"agent_end" }` | — |

**maxToolSteps 처리** (tool_execution_start에서):
```
toolStepCount++
config.maxToolSteps 도달 시 → agent.abort()
```

**tool_end details 구성**:
```
event.result.details           ← tool이 반환한 UI 메타데이터 (sources 배열 등)
event.result.content[].text   ← LLM에 전달된 텍스트

detailsForUi = details에 summary가 없으면 { ...details, summary: resultText }
→ UI tool 블록 RESULT 섹션에 표시
```

---

## 4. RAG Tool 처리

**파일**: `server/tools/rag.ts → ragTool()`

```
Agent가 rag_search 호출
    │
    params.indexes ?? activeIndexes  ← Agent가 인덱스 직접 지정 가능
    │
    POST {RAGAAS_URL}/search
    { query, indexes, topK: 5 }
    │ 실패 시 최대 2회 재시도 (500ms → 1s)
    │
    응답 포맷:
    [1] (출처: ..., 점수: 0.xxx)
    {content}
    ---
    [2] ...

    LLM 전달: 위 텍스트
    UI 전달: details.sources = [{ source, score, indexId }, ...]
              details.summary = 위 텍스트 (tool_end에서 자동 추가)
```

---

## 5. MCP Tool 처리

**파일**: `server/tools/mcp.ts → loadAllMcpTools()`

```
세션 시작 시 (createAgent 호출 시마다)
    │
    DB: SELECT * FROM mcp_servers WHERE user_id = ? AND enabled = 1
    │
    각 서버에 대해 (Promise.allSettled — 한 서버 실패가 전체 블록 안 함)
    ├─ 클라이언트 풀 조회 (서버 ID별 캐시, 재연결 최소화)
    ├─ transport: streamable-http → {url}/mcp
    │             sse           → {url}/sse
    └─ tools/list → AgentTool로 래핑
           name:    mcp_{serverId}_{toolName}
           label:   [{serverName}] {toolName}
           execute: MCP 호출 → 실패 시 1회 재연결 후 재시도
```

---

## 6. 번역 모드 처리

**파일**: `server/translate.ts`, `server/index.ts → type === "translate"`

```
브라우저: isTranslateMode = true
    │ WS 전송: { type:"translate", text, config: { model, targetLang, translatePrompt } }
    ▼
서버: translateDirect(ws, sessionId, text, config, signal)
    │ Agent 루프 없이 streamSimple() 직접 호출 (tool 등록 없음)
    │ 스트리밍 → token 이벤트 전송
    ▼
브라우저: token 이벤트 → text block 렌더링 (일반 채팅과 동일)
```

---

## 7. Stop 처리

**파일**: `frontend/js/app.js → stopGeneration()`, `server/index.ts → type === "stop"`

```
브라우저: Stop 버튼 클릭
    ├─ WS 전송: { type:"stop", sessionId }
    ├─ 열린 thinking/text block 즉시 finalize
    └─ setGenerating(false)

서버 수신:
    ├─ state.agent?.abort()      ← pi-agent-core 루프 중단
    ├─ state.controller.abort()  ← AbortController 중단
    └─ sessions.delete(sessionId)
    (finally에서 generating=0, sessions.delete가 중복 실행될 수 있으나 무해)
```

---

## 8. 브라우저 렌더링 — 블록 기반 상태 머신

**파일**: `frontend/js/app.js → handleWsMessage()`, `frontend/js/chat.js → ChatRenderer`

### 블록 타입

| 블록 | 트리거 | 완료 조건 |
|------|--------|----------|
| **thinking** | 첫 `thinking` 이벤트 | 첫 `token` 이벤트 수신 시 자동 finalize |
| **text** | 첫 `token` 이벤트 (lazy) | `tool_start` / `agent_end` / `stop` |
| **tool_call** | `tool_start` | `tool_end` (dot: running → done/error) |

### 상태 변수

```javascript
state.currentTurnId          // 현재 응답 턴 (아바타 표시 기준)
state.currentTextBlockId     // 현재 열린 text block
state.currentThinkingBlockId // 현재 열린 thinking block
state.lastEventWasToolCall   // tool_end 직후 → true, 다음 token 시 새 text block 생성
```

### 이벤트별 처리

```
thinking 수신
    └─ currentThinkingBlockId 없으면 startThinkingBlock()
    └─ appendThinking(delta)

token 수신
    ├─ currentThinkingBlockId 있으면 finalizeThinkingBlock()
    ├─ currentTextBlockId 없거나 lastEventWasToolCall=true이면 startTextBlock()
    │     lastEventWasToolCall = false
    └─ appendToken(delta)

tool_start 수신
    ├─ currentTextBlockId 있으면 finalizeTextBlock()
    │     currentTextBlockId = null
    ├─ lastEventWasToolCall = true
    └─ addToolCallBlock(toolCallId, toolName, toolLabel, params)

tool_end 수신
    └─ updateToolCallBlock(toolCallId, details)
           RESULT 섹션: details.summary || details.result 표시
           dot: dot-running → dot-done / dot-error
           소요 시간 표시

agent_end 수신
    ├─ thinking/text block finalize
    ├─ currentTurnId = null
    └─ setGenerating(false)
```

### Markdown 렌더링

- text block은 스트리밍 중 raw 텍스트 누적 (`_rawBuffers`)
- `finalizeTextBlock()` 시점에 한 번만 Markdown → HTML 변환 + 코드 하이라이팅

---

## 9. DB 영속화

### 메시지 저장

| 시점 | 동작 |
|------|------|
| 사용자 메시지 전송 직후 | `INSERT INTO messages` (role: user) |
| agent.prompt() 완료 후 | `INSERT INTO messages` (role: assistant, content: 전체 AgentMessage JSON) |
| tool_execution_start | `INSERT INTO tool_calls` (id, message_id, tool_name, args, order_idx) |
| tool_execution_end | `UPDATE tool_calls` (result, is_error, ended_at) |

### 히스토리 복원

```
loadHistory(sessionId)
    → SELECT role, content FROM messages ORDER BY created_at ASC
    → JSON.parse(content)
    → assistant 메시지: AgentMessage 객체 그대로 복원
    → user 메시지: { role, content, timestamp } 형태로 변환
    → agent.replaceMessages(history)
```

### 서버 재시작 복구

```
서버 시작 시:
    SELECT id FROM sessions WHERE generating = 1
    → 각 세션에 "서버가 재시작되어 응답이 중단되었습니다" 메시지 삽입
    → generating = 0 으로 초기화
```

---

## 10. WS 메시지 타입 전체 목록

### 브라우저 → 서버

| type | 용도 |
|------|------|
| `chat` | 일반 채팅 메시지 전송 |
| `translate` | 번역 요청 |
| `stop` | 생성 중단 |
| `sessions.list` | 세션 목록 요청 |
| `sessions.delete` | 세션 삭제 |

### 서버 → 브라우저

| type | 용도 |
|------|------|
| `thinking` | thinking 스트리밍 delta |
| `token` | 텍스트 스트리밍 delta |
| `tool_start` | tool 실행 시작 |
| `tool_end` | tool 실행 완료 (details 포함) |
| `agent_end` | Agent 루프 완료 |
| `error` | 오류 |
| `compaction` | 컨텍스트 압축 알림 |
| `model_health` | 모델 온라인/오프라인 상태 |
| `sessions.list` | 세션 목록 응답 |
| `sessions.deleted` | 세션 삭제 완료 |

---

## 11. config 객체 (ChatConfig)

브라우저 → 서버로 전달되는 채팅 설정값.

```typescript
interface ChatConfig {
  model: string;           // 모델 ID (e.g., "GLM4.7")
  indexes: string[];       // 활성 RAG 인덱스 목록
  tools: string[];         // 활성 tool ("rag" 포함 여부)
  temperature?: number;    // 온도 (streamFnWithConfig에 주입)
  maxTokens?: number;      // 최대 토큰 — model.maxTokens 오버라이드
  maxToolSteps?: number;   // 최대 tool 실행 횟수 — 초과 시 agent.abort()
  thinkingMode?: string;   // "off" | "minimal" | "low" | "medium" | "high"
}
```
