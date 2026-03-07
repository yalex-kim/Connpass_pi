# Connpass 컨텍스트 관리 상세 문서

> 작성일: 2026-03-07
> 목적: LLM에 전달되는 컨텍스트 구조, 컴팩션 동작, 개선 방향 문서화

---

## 1. 현재 컨텍스트 구조

매 채팅 턴마다 LLM에 전달되는 내용:

```
┌─────────────────────────────────────────────────────────┐
│ SYSTEM PROMPT (buildSystemPrompt() — server/agent.ts)  │
│                                                         │
│  1. 기본 역할 지시 (하드코딩 문자열)                    │
│     "당신은 BT/WiFi 펌웨어 엔지니어링팀을 위한..."      │
│                                                         │
│  2. Jira 서버 목록 (DB: jira_servers WHERE enabled=1)   │
│     "- id: 'jira-1' name: 'Samsung Jira'"               │
│                                                         │
│  3. 사용자 커스텀 지시 (DB: user_settings.agent_md)     │
│     "---\n사용자 커스텀 지시사항:\n{user text}"         │
│                                                         │
│  4. Skills 섹션 (FS: skills/ + skills-user/{uid}/)      │
│     "## 사용 가능한 스킬\n..."                           │
└─────────────────────────────────────────────────────────┘
                        +
┌─────────────────────────────────────────────────────────┐
│ MESSAGE HISTORY (loadHistory() — server/index.ts)       │
│                                                         │
│  [0] { role: "user", content: "...", timestamp }        │
│  [1] { role: "assistant",                               │
│         content: [TextBlock | ThinkingBlock |           │
│                   ToolCallBlock],                       │
│         usage: { inputTokens, outputTokens },           │
│         stopReason: "stop" | "toolUse" }                │
│  [2] { role: "user", content: "...", timestamp }        │
│  ...                                                    │
│  [N] 새 유저 메시지 (agent.prompt()로 추가)             │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 컴팩션 현황

### 현재 상태: **컴팩션 미구현**

| 항목 | 상태 |
|------|------|
| pi-agent-core 자체 컴팩션 | 없음 — raw agent loop만 제공 |
| pi-coding-agent 컴팩션 | 있음 — 단, Connpass는 이 레이어 미사용 |
| Connpass 서버 컴팩션 | ❌ 미구현 — 전체 히스토리 무조건 전송 |
| UI compaction 이벤트 | 렌더링 코드는 있음 — 서버가 보내는 코드 없음 |

### 결론
현재 Connpass는 세션의 **전체 메시지 히스토리**를 매 턴마다 LLM에 전송한다.
Kimi-K2.5 (32K 컨텍스트) 기준으로 중간 길이 세션도 한도를 초과할 수 있다.

---

## 3. 컴팩션 구현 시 보존/요약 범위

| 구성 요소 | 컴팩션 대상 여부 | 이유 |
|---|---|---|
| System prompt (기본 지시) | ❌ **항상 보존** | LLM API 규격상 system은 별도 전달 |
| agent.md 커스텀 지시 | ❌ **항상 보존** | system prompt에 포함 |
| Skills 섹션 | ❌ **항상 보존** | system prompt에 포함 |
| Jira 서버 목록 | ❌ **항상 보존** | system prompt에 포함 |
| 최근 N개 메시지 | ❌ **항상 보존** | 컴팩션 시 최신 컨텍스트 유지 |
| 오래된 user/assistant 메시지 | ✅ **요약됨** | 컴팩션 summary 블록으로 치환 |
| Tool 결과 (오래된 메시지 내) | ✅ **요약됨** | AssistantMessage.content에 포함 |
| ThinkingBlock (오래된) | ✅ **요약됨** | AssistantMessage.content에 포함 |

### 컴팩션 후 메시지 배열 구조 (예시)

```
[0] { role: "user", content: "[이전 대화 요약: ...]" }   ← 컴팩션 summary
[1] { role: "assistant", content: [...] }               ← 최근 메시지 유지
[2] { role: "user", content: "..." }                    ← 최근 메시지 유지
[3] 새 유저 메시지
```

---

## 4. 메시지 영속성 구조 (DB)

### messages 테이블
```sql
id          TEXT PRIMARY KEY
session_id  TEXT NOT NULL  -- FK → sessions
role        TEXT           -- "user" | "assistant"
content     TEXT           -- 전체 AgentMessage JSON 직렬화
created_at  TEXT
```

**특징:**
- AssistantMessage 전체 객체(usage, stopReason, content[] 포함)가 JSON으로 저장됨
- pi-agent-core 내부 구조 변경 시 기존 세션 파싱 실패 가능
- Tool 결과가 assistant message content[] 안에 임베딩되어 별도 분리 불가

### tool_calls 테이블 (별도 추적)
```sql
id, message_id, session_id, tool_name, tool_label,
args, result, is_error, started_at, ended_at, order_idx
```

---

## 5. 개선 방향

### 5-A. 단기: 히스토리 트리밍 (token guard)
- `loadHistory()` 후 chars/4 로 토큰 추정
- 컨텍스트 윈도우 60% 초과 시 오래된 메시지 제거
- 제거 구간에 sentinel 메시지 삽입

### 5-B. 중기: 실제 컴팩션 구현
- 80% 이상 도달 시 LLM으로 이전 메시지 요약 생성
- 요약 결과를 DB에 `compaction_summary` 형태로 저장
- UI에 컴팩션 발생 알림 (이미 렌더링 코드 있음)

### 5-C. 장기기억과의 관계
- 컴팩션으로 요약/삭제된 메시지에서도 중요 정보가 유실됨
- **장기기억 시스템**이 이를 보완: 세션 내 중요 사실을 벡터 DB에 영속 저장
- 세션 종료 시 → 장기기억 추출 → 다음 세션 시작 시 관련 기억 주입
