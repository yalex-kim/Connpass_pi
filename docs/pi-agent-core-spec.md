# @mariozechner/pi-agent-core 명세

Agent loop 레이어. pi-ai 위에서 동작하며 tool calling, 이벤트 구독, 상태 관리를 담당한다.
LLM이 tool을 호출하면 자동으로 실행하고 결과를 피드백하며, 최종 응답이 나올 때까지 루프를 반복한다.
**MIT 라이센스 — 상업적 사용 가능.**

## 설치

```bash
npm install @mariozechner/pi-ai @mariozechner/pi-agent-core
```

---

## 1. Tool 정의

TypeBox 스키마로 타입 안전한 파라미터를 정의한다.
AJV로 자동 검증되므로 LLM이 잘못된 인자를 넘겨도 에러 메시지가 자동으로 피드백된다.

```typescript
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// 파라미터 스키마를 별도 변수로 선언 (제네릭 타입 추론을 위해 필수)
const ragSearchParams = Type.Object({
  query: Type.String({ description: "검색할 쿼리" }),
  index: Type.Optional(Type.String({ description: "검색할 RAG 인덱스명" })),
});

const ragSearchTool: AgentTool<typeof ragSearchParams> = {
  name: "rag_search",
  label: "RAG 검색",
  description: "내부 문서에서 관련 내용을 검색합니다. Jira 이슈, Confluence 문서, BT/WiFi 스펙 등을 검색할 수 있습니다.",
  parameters: ragSearchParams,
  execute: async (toolCallId, params, signal, onUpdate) => {
    // params는 타입 추론됨: { query: string; index?: string }
    const result = await fetch("http://localhost:5000/api/rag/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal, // Stop 기능과 연동
    });
    const data = await result.json();

    return {
      content: [{ type: "text", text: data.result }], // LLM에 전달되는 내용
      details: { sources: data.sources },              // UI용 메타데이터 (LLM에 전달 안 됨)
    };
  },
};
```

### Tool 필드 설명

| 필드 | 필수 | 설명 |
|------|------|------|
| `name` | ✅ | LLM이 호출할 때 사용하는 식별자 |
| `label` | ❌ | UI 표시용 이름 |
| `description` | ✅ | LLM이 언제/어떻게 쓸지 판단하는 설명. 충분히 상세하게 작성 |
| `parameters` | ✅ | TypeBox 스키마 (AJV로 자동 검증) |
| `execute` | ✅ | 실제 로직. `content`는 LLM으로, `details`는 UI로만 전달 |

### execute 파라미터

```typescript
execute: async (
  toolCallId: string,         // 이번 tool call의 고유 ID
  params: Static<TParams>,    // 스키마 기반 타입 추론된 파라미터
  signal?: AbortSignal,       // Stop 버튼 연동용
  onUpdate?: (update: ToolResult) => void  // 진행 중 부분 결과 스트리밍용
) => Promise<ToolResult>
```

---

## 2. Flask API 호출 Tool 패턴

사내 서비스에서 Flask(Python)가 RAG/Jira/MCP 로직을 담당하고,
pi-agent-core Tool이 HTTP로 호출하는 구조.

```typescript
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// Jira 이슈 검색 Tool
const jiraSearchParams = Type.Object({
  jql: Type.String({ description: "Jira Query Language 쿼리. 예: project=BT AND status=Open" }),
  maxResults: Type.Optional(Type.Number({ description: "최대 결과 수, 기본값 10" })),
});

const jiraSearchTool: AgentTool<typeof jiraSearchParams> = {
  name: "jira_search",
  label: "Jira 검색",
  description: "JQL로 Jira 이슈를 검색합니다. 버그, 태스크, 에픽 등을 조회할 수 있습니다.",
  parameters: jiraSearchParams,
  execute: async (toolCallId, params, signal) => {
    const res = await fetch("http://localhost:5000/api/jira/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });

    if (!res.ok) {
      return {
        content: [{ type: "text", text: `Jira 검색 실패: ${res.status} ${res.statusText}` }],
        details: { error: true },
      };
    }

    const data = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data.issues, null, 2) }],
      details: { count: data.total, issues: data.issues },
    };
  },
};

// MCP Tool 호출
const mcpCallParams = Type.Object({
  server: Type.String({ description: "MCP 서버 이름" }),
  tool: Type.String({ description: "호출할 MCP tool 이름" }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "tool 인자" })),
});

const mcpCallTool: AgentTool<typeof mcpCallParams> = {
  name: "mcp_call",
  label: "MCP Tool 호출",
  description: "등록된 MCP 서버의 tool을 호출합니다. Gerrit, Confluence 등 외부 서비스와 연동할 때 사용합니다.",
  parameters: mcpCallParams,
  execute: async (toolCallId, params, signal) => {
    const res = await fetch("http://localhost:5000/api/mcp/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    const data = await res.json();
    return {
      content: [{ type: "text", text: data.result }],
      details: data.metadata ?? {},
    };
  },
};
```

---

## 3. Agent 생성

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
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

const agent = new Agent({
  initialState: {
    systemPrompt: `당신은 BT/WiFi 펌웨어 개발팀을 위한 AI 어시스턴트입니다.
내부 문서 검색, Jira 이슈 조회, Gerrit 코드 리뷰 등을 도울 수 있습니다.`,
    model: internalModel,
    tools: [ragSearchTool, jiraSearchTool, mcpCallTool],
    thinkingLevel: "off", // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  },
  streamFn: streamSimple,
});
```

---

## 4. 이벤트 구독

```typescript
agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
      console.log("Agent 시작");
      break;

    case "turn_start":
      console.log("턴 시작");
      break;

    case "message_update":
      // LLM 스트리밍 텍스트
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
        // WebSocket으로 브라우저에 전달하는 경우:
        // ws.send(JSON.stringify({ type: "text_delta", delta: event.assistantMessageEvent.delta }));
      }
      break;

    case "tool_execution_start":
      console.log(`\nTool 실행: ${event.toolName}`);
      console.log(`인자: ${JSON.stringify(event.args)}`);
      break;

    case "tool_execution_update":
      // onUpdate 콜백으로 전달된 부분 결과 (긴 작업 중간 상태)
      break;

    case "tool_execution_end":
      if (event.isError) {
        console.log(`Tool 실패: ${event.toolName}`);
      } else {
        console.log(`Tool 완료: ${event.toolName}`);
        // event.result.details 로 UI용 메타데이터 접근
      }
      break;

    case "turn_end":
      console.log("턴 완료");
      break;

    case "agent_end":
      console.log("Agent 완료");
      break;
  }
});
```

### 이벤트 타입 전체

| 이벤트 | 설명 |
|--------|------|
| `agent_start` | Agent 루프 시작 |
| `agent_end` | Agent 루프 종료 (LLM이 tool 없이 응답하면 종료) |
| `turn_start` | LLM 호출 1회 시작 |
| `turn_end` | LLM 호출 1회 완료 |
| `message_start` | assistant 메시지 블록 시작 |
| `message_update` | LLM 스트리밍 이벤트 (`assistantMessageEvent` 필드에 pi-ai 이벤트 포함) |
| `message_end` | assistant 메시지 완료 |
| `tool_execution_start` | tool 실행 시작 (`toolName`, `args` 포함) |
| `tool_execution_update` | tool 실행 중 부분 결과 |
| `tool_execution_end` | tool 실행 완료 (`result`, `isError` 포함) |

---

## 5. Agent 실행

```typescript
// 기본 프롬프트
await agent.prompt("Bluetooth 연결 실패 관련 Jira 이슈 찾아줘");

// Stop 기능 (AbortController 연동)
const controller = new AbortController();

stopButton.addEventListener("click", () => controller.abort());

await agent.prompt("긴 작업 요청", { signal: controller.signal });
```

Agent 루프 흐름:
1. 사용자 메시지를 LLM에 전달
2. LLM이 tool call을 포함한 응답 생성
3. Agent가 tool 실행 후 결과를 LLM에 피드백
4. LLM이 tool 없이 최종 텍스트 응답 → 루프 종료

---

## 6. Agent 상태 변경

실행 중에도 모델, 시스템 프롬프트, 도구 목록 변경 가능.

```typescript
agent.setState({ model: anotherModel });
agent.setState({ systemPrompt: "새로운 역할 지시사항" });
agent.setState({ tools: [...existingTools, newTool] });
```

---

## 7. WebSocket 스트리밍 패턴 (브라우저 연동)

```typescript
import { WebSocket } from "ws";
import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

function setupAgent(ws: WebSocket) {
  const controller = new AbortController();

  const agent = new Agent({
    initialState: {
      systemPrompt: "...",
      model: internalModel,
      tools: [ragSearchTool, jiraSearchTool],
      thinkingLevel: "off",
    },
    streamFn: streamSimple,
  });

  // 이벤트 → WebSocket 브로드캐스트
  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          ws.send(JSON.stringify({
            type: "text_delta",
            delta: event.assistantMessageEvent.delta,
          }));
        }
        break;

      case "tool_execution_start":
        ws.send(JSON.stringify({
          type: "tool_start",
          tool: event.toolName,
          args: event.args,
        }));
        break;

      case "tool_execution_end":
        ws.send(JSON.stringify({
          type: "tool_end",
          tool: event.toolName,
          isError: event.isError,
          details: event.result?.details,
        }));
        break;

      case "agent_end":
        ws.send(JSON.stringify({ type: "done" }));
        break;
    }
  });

  // 브라우저 메시지 수신 → Agent 실행
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "prompt") {
      await agent.prompt(msg.text, { signal: controller.signal });
    }

    if (msg.type === "stop") {
      controller.abort();
    }
  });
}
```
