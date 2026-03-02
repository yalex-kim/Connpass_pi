# @mariozechner/pi-coding-agent 명세

세션 관리, 컨텍스트 컴팩션, 확장 시스템을 갖춘 풀 Agent 런타임.
pi-agent-core 위에서 동작하며 JSONL 기반 세션 영속성, 자동 컴팩션, Skill 시스템을 제공한다.
**MIT 라이센스 — 상업적 사용 가능.**

> **사내 서비스에서 활용 포인트:**
> - 세션 저장/복원: SQLite 대신 pi-coding-agent의 세션 관리 활용 가능
> - 컴팩션: 컨텍스트 한계 도달 시 자동 요약으로 대화 지속
> - SDK 모드: 독립 프로세스로 실행 후 기존 Flask/JS 앱과 RPC 연동 가능

## 설치

```bash
npm install @mariozechner/pi-ai @mariozechner/pi-agent-core @mariozechner/pi-coding-agent
```

---

## 1. SDK 모드 — createAgentSession

가장 간단한 진입점. 세션 관리, 컴팩션이 자동으로 처리된다.

```typescript
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

async function main() {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),   // 인메모리 세션 (재시작 시 초기화)
    // sessionManager: SessionManager.file("./sessions"), // 파일 기반 세션 (영속)
    authStorage,
    modelRegistry,
  });

  // 프롬프트 실행
  await session.prompt("현재 디렉토리의 파일을 알려줘");
}

main();
```

### SessionManager 옵션

```typescript
// 인메모리 (테스트, 일회성 작업)
SessionManager.inMemory()

// 파일 기반 JSONL 영속 세션
SessionManager.file("./sessions-directory")

// 커스텀 (DB 연동 등)
SessionManager.custom({
  load: async (sessionId) => { /* ... */ },
  save: async (sessionId, messages) => { /* ... */ },
})
```

---

## 2. 커스텀 모델 연결

사내 vLLM을 세션에 연결하는 방법.

```typescript
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

const internalModel: Model<"openai-completions"> = {
  id: "your-model-name",
  name: "Internal LLM",
  api: "openai-completions",
  provider: "internal",
  baseUrl: "http://사내-vllm/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

// 커스텀 모델을 레지스트리에 등록
modelRegistry.register(internalModel);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  // 세션에 기본 모델 지정
  model: internalModel,
});
```

---

## 3. 커스텀 Tool 추가

```typescript
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const ragSearchParams = Type.Object({
  query: Type.String({ description: "검색 쿼리" }),
});

const ragSearchTool: AgentTool<typeof ragSearchParams> = {
  name: "rag_search",
  label: "RAG 검색",
  description: "내부 문서 검색. Confluence, Jira, BT/WiFi 스펙 문서를 검색합니다.",
  parameters: ragSearchParams,
  execute: async (toolCallId, params, signal) => {
    const res = await fetch("http://localhost:5000/api/rag/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    const data = await res.json();
    return {
      content: [{ type: "text", text: data.result }],
      details: { sources: data.sources },
    };
  },
};

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  model: internalModel,
  tools: [ragSearchTool],  // 커스텀 tool 주입
});

await session.prompt("Bluetooth 페어링 실패 관련 문서 찾아줘");
```

---

## 4. 세션 이벤트 구독

```typescript
const { session, agent } = await createAgentSession({ /* ... */ });

// agent는 pi-agent-core의 Agent 인스턴스
agent.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;

    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;

    case "agent_end":
      console.log("완료");
      break;
  }
});

await session.prompt("질문 내용");
```

---

## 5. 컴팩션 (자동 요약)

컨텍스트 한계에 가까워지면 이전 대화를 자동으로 요약하여 대화를 지속한다.
기본적으로 내장되어 있으며 별도 설정 없이 동작한다.

```typescript
// 컴팩션 설정 커스터마이징 (선택사항)
const { session } = await createAgentSession({
  sessionManager: SessionManager.file("./sessions"),
  authStorage,
  modelRegistry,
  model: internalModel,
  compaction: {
    // 컨텍스트 사용률이 이 비율을 넘으면 컴팩션 트리거
    threshold: 0.8,
    // 요약에 사용할 모델 (기본: 현재 모델)
    model: internalModel,
  },
});
```

---

## 6. 세션 저장 및 복원

```typescript
import { SessionManager } from "@mariozechner/pi-coding-agent";

// 파일 기반 세션 (JSONL 포맷으로 ./sessions 디렉토리에 저장)
const sessionManager = SessionManager.file("./sessions");

const { session } = await createAgentSession({
  sessionManager,
  authStorage,
  modelRegistry,
  model: internalModel,
  sessionId: "user-123-session-456", // 특정 세션 ID 지정 시 이전 대화 복원
});

// 세션 ID 확인
console.log(session.id);

// 나중에 동일한 sessionId로 createAgentSession 호출하면 이전 대화 이어서 가능
```

---

## 7. RPC 모드 (Node.js 외 언어와 연동)

pi-coding-agent를 별도 프로세스로 실행하고 stdin/stdout JSON 프로토콜로 통신.
Flask(Python) 백엔드에서 pi를 서브프로세스로 실행하여 연동할 수 있다.

```python
# Python에서 pi RPC 모드 실행 예시
import subprocess, json

proc = subprocess.Popen(
    ["npx", "pi", "--mode", "rpc"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
)

# 메시지 전송
msg = {"type": "prompt", "text": "Jira 이슈 검색해줘"}
proc.stdin.write(json.dumps(msg).encode() + b"\n")
proc.stdin.flush()

# 응답 수신
for line in proc.stdout:
    event = json.loads(line)
    if event["type"] == "text_delta":
        print(event["delta"], end="", flush=True)
    elif event["type"] == "done":
        break
```

---

## 8. 사내 서비스 통합 아키텍처 권장 패턴

```
┌──────────────────────────────────────────────────────┐
│  브라우저 (app.js)                                    │
│  - UI 렌더링                                          │
│  - WebSocket으로 스트리밍 수신                        │
└────────────────────┬─────────────────────────────────┘
                     │ WebSocket
┌────────────────────▼─────────────────────────────────┐
│  Node.js 서버 (server.js)                             │
│  - pi-agent-core Agent 실행                           │
│  - createAgentSession (pi-coding-agent)               │
│  - 커스텀 Tool → Flask API HTTP 호출                  │
│  - 이벤트 → WebSocket 브로드캐스트                    │
└────────────────────┬─────────────────────────────────┘
                     │ HTTP REST
┌────────────────────▼─────────────────────────────────┐
│  Flask 서버 (app.py)                                  │
│  - RAG 검색 (/api/rag/search)                         │
│  - Jira 조회 (/api/jira/search)                       │
│  - MCP 연동 (/api/mcp/call)                           │
│  - Skill 관리 (/api/skills)                           │
│  - SQLite DB                                          │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│  사내 인프라                                           │
│  - vLLM (GLM4.7 / Kimi-K2.5 / GPT-OSS-120B)         │
│  - RAGaaS (Confluence, Jira, BT/WiFi Spec 등 14개)   │
│  - Gerrit / Jira MCP 서버                             │
└──────────────────────────────────────────────────────┘
```

### 최소 구현 예시 (Node.js server.js)

```typescript
import express from "express";
import { WebSocketServer } from "ws";
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { streamSimple } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

const app = express();
const server = app.listen(3000);
const wss = new WebSocketServer({ server });

const internalModel: Model<"openai-completions"> = {
  id: "your-model-name",
  name: "Internal LLM",
  api: "openai-completions",
  provider: "internal",
  baseUrl: "http://사내-vllm/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

// Flask API 호출 Tool들
const ragTool: AgentTool<any> = {
  name: "rag_search",
  label: "RAG 검색",
  description: "내부 문서 검색 (Confluence, Jira, BT/WiFi Spec 등)",
  parameters: Type.Object({ query: Type.String() }),
  execute: async (id, params, signal) => {
    const res = await fetch("http://localhost:5000/api/rag/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    const data = await res.json();
    return { content: [{ type: "text", text: data.result }], details: {} };
  },
};

wss.on("connection", async (ws) => {
  const controller = new AbortController();
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  modelRegistry.register(internalModel);

  const { session, agent } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model: internalModel,
    tools: [ragTool],
  });

  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      ws.send(JSON.stringify({ type: "text_delta", delta: event.assistantMessageEvent.delta }));
    }
    if (event.type === "tool_execution_start") {
      ws.send(JSON.stringify({ type: "tool_start", tool: event.toolName }));
    }
    if (event.type === "agent_end") {
      ws.send(JSON.stringify({ type: "done" }));
    }
  });

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "prompt") {
      await session.prompt(msg.text, { signal: controller.signal });
    }
    if (msg.type === "stop") {
      controller.abort();
    }
  });
});
```
