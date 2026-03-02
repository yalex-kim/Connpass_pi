# @mariozechner/pi-ai 명세

LLM 통신 레이어. Anthropic, OpenAI, Google, Groq, Ollama, vLLM 등 멀티 프로바이더를 단일 API로 추상화한다.
스트리밍, tool calling, thinking/reasoning 지원. **MIT 라이센스 — 상업적 사용 가능.**

## 설치

```bash
npm install @mariozechner/pi-ai
```

---

## 1. 모델 정의

### 등록된 모델 사용

```typescript
import { getModel } from "@mariozechner/pi-ai";

const model = getModel("anthropic", "claude-sonnet-4-20250514");
// const model = getModel("openai", "gpt-4o");
// const model = getModel("google", "gemini-2.5-pro");
// const model = getModel("groq", "llama-3.3-70b-versatile");
```

### 사내 vLLM 커스텀 모델 정의

`api: "openai-completions"` 사용 시 OpenAI 호환 endpoint라면 어디든 연결 가능.
사내 vLLM이 OpenAI 호환 API를 제공한다면 이 방식으로 연결한다.

```typescript
import type { Model } from "@mariozechner/pi-ai";

const internalModel: Model<"openai-completions"> = {
  id: "your-model-name",           // 모델 ID (vLLM에서 서빙 중인 모델명)
  name: "Internal LLM",            // 표시용 이름 (자유롭게 지정)
  api: "openai-completions",       // OpenAI 호환 endpoint 사용 시 이 값 고정
  provider: "internal",            // 임의의 provider 이름
  baseUrl: "http://사내-vllm/v1",  // 사내 vLLM 주소
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};
```

API 키 처리:

```typescript
// 방법 1: 환경변수로 자동 감지 (OPENAI_API_KEY, ANTHROPIC_API_KEY 등)
// 방법 2: 호출 시 직접 전달
const stream = streamSimple(model, context, { apiKey: "your-key" });
// 방법 3: 인증 불필요한 경우 (사내 vLLM 등) apiKey 생략 가능
```

---

## 2. LLM 호출

### completeSimple — 전체 응답 대기 (non-streaming)

```typescript
import { completeSimple } from "@mariozechner/pi-ai";

const response = await completeSimple(model, {
  systemPrompt: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "질문 내용", timestamp: Date.now() }
  ],
});

// response.content: Array<TextBlock | ThinkingBlock | ToolCallBlock>
for (const block of response.content) {
  if (block.type === "text") {
    console.log(block.text);
  }
}

console.log(response.usage.totalTokens);
// response.stopReason: "stop" | "toolUse" | "length" | "error" | "aborted"
console.log(response.stopReason);
```

### streamSimple — 실시간 스트리밍

모든 프로바이더의 스트리밍 포맷을 단일 이벤트 스트림으로 정규화한다.
핸들러를 한 번 작성하면 어떤 프로바이더든 동일하게 동작한다.

```typescript
import { streamSimple } from "@mariozechner/pi-ai";

const stream = streamSimple(model, {
  systemPrompt: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "질문 내용", timestamp: Date.now() }
  ],
});

for await (const event of stream) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta); // 스트리밍 텍스트 청크
      break;
    case "thinking_delta":
      // thinking 모드 활성화 시 사고 과정 스트리밍
      break;
    case "done":
      console.log(`완료. 토큰: ${event.message.usage.totalTokens}`);
      break;
    case "error":
      console.error("에러:", event.error.errorMessage);
      break;
  }
}

// 스트리밍 없이 최종 메시지만 필요한 경우
const finalMessage = await stream.result(); // AssistantMessage
```

### 스트리밍 이벤트 타입 전체

| 이벤트 | 설명 |
|--------|------|
| `start` | 스트리밍 시작 |
| `text_start` | 텍스트 블록 시작 |
| `text_delta` | 텍스트 청크 (주로 이것만 처리하면 됨) |
| `text_end` | 텍스트 블록 완료 |
| `thinking_start` | thinking 블록 시작 |
| `thinking_delta` | thinking 청크 |
| `thinking_end` | thinking 블록 완료 |
| `toolcall_start` | tool call 시작 |
| `toolcall_delta` | tool call 인자 스트리밍 (부분 JSON) |
| `toolcall_end` | tool call 완료 |
| `done` | 전체 완료, `event.message`에 최종 AssistantMessage 포함 |
| `error` | 에러 발생 |

---

## 3. Abort (중단)

```typescript
const controller = new AbortController();

// 예: Stop 버튼 클릭 시
stopButton.addEventListener("click", () => controller.abort());

const stream = streamSimple(model, context, {
  signal: controller.signal
});

for await (const event of stream) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  } else if (event.type === "error") {
    if (event.reason === "aborted") console.log("중단됨");
  }
}

// 중단된 경우에도 부분 결과 반환
const response = await stream.result();
if (response.stopReason === "aborted") {
  console.log("부분 결과:", response.content);
}
```

---

## 4. Thinking (추론 모드)

Claude, o3, Gemini 2.5 등 thinking을 지원하는 모델에서 사용 가능.

```typescript
const stream = streamSimple(model, context, {
  reasoning: "high", // "minimal" | "low" | "medium" | "high" | "xhigh"
});

for await (const event of stream) {
  if (event.type === "thinking_delta") {
    // 사고 과정 (UI 표시 또는 무시)
  }
  if (event.type === "text_delta") {
    // 최종 답변
  }
}
```

---

## 5. Context (대화 이력)

```typescript
import { complete } from "@mariozechner/pi-ai";
import type { Context } from "@mariozechner/pi-ai";

const context: Context = { messages: [] };

// 사용자 메시지 추가
context.messages.push({
  role: "user",
  content: "안녕하세요",
  timestamp: Date.now()
});

// LLM 호출
const response = await complete(model, context);

// assistant 응답을 context에 추가하여 대화 이어가기
context.messages.push(response);

// 다음 턴
context.messages.push({ role: "user", content: "계속해줘", timestamp: Date.now() });

// Context 직렬화 (세션 저장)
const saved = JSON.stringify(context);

// Context 역직렬화 (세션 복귀)
const restored: Context = JSON.parse(saved);
```

---

## 6. 주요 타입

```typescript
// 모델 정의
type Model<T extends ApiType = ApiType> = {
  id: string;
  name: string;
  api: T;           // "openai-completions" | "anthropic" | "google" | "openai-responses"
  provider: string;
  baseUrl?: string; // 커스텀 endpoint (사내 vLLM 등)
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

// 대화 이력
type Context = {
  messages: Array<UserMessage | AssistantMessage | ToolResultMessage>;
};

type UserMessage = {
  role: "user";
  content: string;
  timestamp: number;
};

type AssistantMessage = {
  role: "assistant";
  content: Array<TextBlock | ThinkingBlock | ToolCallBlock>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  stopReason: "stop" | "toolUse" | "length" | "error" | "aborted";
};

// Tool 결과 타입
type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: Record<string, unknown>; // UI용 데이터, LLM에 전달되지 않음
};
```
