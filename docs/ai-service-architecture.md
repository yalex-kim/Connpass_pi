# 사내 AI 서비스 아키텍처 설계 문서

> 작성일: 2026-02-28  
> 대상: BT/WiFi 엔지니어링 팀 내부 LLM + RAG 기반 지식 검색 서비스

---

## 1. 프로젝트 개요

사내 LLM과 RAG를 결합한 지식 검색 서비스. 엔지니어가 자연어로 질문하면 관련 문서를 검색하고, Jira/Gerrit 같은 업무 도구와 연동해 자동화된 워크플로우를 실행할 수 있는 플랫폼.

---

## 2. 인프라 현황

- **LLM**: 사내 vLLM 서버 (GLM4.7, Kimi-K2.5, GPT-OSS-120B)
  - tool_call, streaming 지원
  - OpenAI 호환 API (`/v1/chat/completions`)
- **임베딩 모델**: 사내 vLLM으로 서비스 중 (`/v1/embeddings`, OpenAI 호환)
- **RAGaaS**: 14개 인덱스 운영 중
  - Confluence, 내부/외부 문서, BT/WiFi Spec, Requirement 버전별, Jira, Gerrit
- **DB**: SQLite
- **백엔드**: Node.js Express — REST API + SQLite (better-sqlite3) 직접 접근. Flask 없음.
- **Agent 엔진**: Node.js — `@mariozechner/pi-agent-core` (MIT)
- **프론트엔드**: JavaScript

---

## 3. Agent Loop 아키텍처

**`@mariozechner/pi-agent-core` 라이브러리 사용** (OpenClaw의 Agent 엔진과 동일).
상세 API는 → `pi-agent-core-spec.md`, `pi-ai-spec.md`, `pi-coding-agent-spec.md` 참조.

### 전환 배경
초기 Flask(Python) 기반 Agent loop 직접 구현에서 전환.
Flask의 async 한계로 streaming/tool call 비동기 처리가 불편했으며,
pi-agent-core가 세션 관리·컴팩션을 내장하여 직접 유지 부담이 없어짐.

### 현재 구조

```
[브라우저 app.js]
    ↕ WebSocket + HTTP (localhost:5001)
[Node.js 서버]  ← pi-agent-core Agent loop + Express REST API + SQLite
    ↕ MCP (streamable-http)      ↕ pi-ai (직통)
[로컬 MCP 서버]               [사내 vLLM / RAGaaS / Gerrit / Jira]
```

> Flask는 완전히 제거됨. Python 전용 연산이 필요하면 FastAPI MCP 서버로 추가.

### pi-agent-core가 담당하는 것
- Tool call 루프 (자동 실행 → 결과 피드백 → 반복)
- 세션 관리 및 대화 이력 저장 (`pi-coding-agent` SessionManager)
- 컴팩션 (컨텍스트 한계 도달 시 자동 요약)
- Stop 기능 (`AbortController` 연동)
- 이벤트 스트리밍 (`agent_start`, `message_update`, `tool_execution_*`, `agent_end`)

### Node.js Express가 담당하는 것 (REST API로 노출)
- RAG 검색 — RAGaaS 직접 호출 (`/api/rag/search`)
- Jira 조회/업데이트 (`/api/jira/*`)
- MCP 서버 관리 (`/api/mcp/*`)
- Skill 파일 관리 (`/api/skills`)
- 임시 RAG 파일 업로드 — Phase 8 구현 예정 (`/api/sessions/:id/upload`)
- SQLite DB 관리 (better-sqlite3 직접 접근)

### 다음 스텝 제안
Agent 응답 마지막에 관련 액션 제안 (텍스트 → 추후 버튼 UI로 전환):
```
💡 다음 단계로 이런 것들을 해볼 수 있어요:
- BT-1234 관련 Gerrit 커밋 찾아볼까요?
- BT 연결 끊김 관련 Spec 문서 확인할까요?
```

---

## 4. 페르소나 및 RAG Index 선택

### 페르소나
- **BT 페르소나**: BT 관련 6개 인덱스 자동 선택
- **WiFi 페르소나**: WiFi 관련 8개 인덱스 자동 선택

### 현재 문제점
모든 인덱스에서 각 5개씩 검색 → 상위 10개 추려서 답변 (14×5=70개 청크). 비효율적.

### 개선 방향
1. 페르소나로 후보군 축소 (6~8개)
2. 사용자가 UI로 추가 인덱스 선택 가능 (전체 검색 옵션 포함)
3. Agent가 질문 의도 파악해서 관련 인덱스 2~3개만 선택
4. 선택된 인덱스만 검색

### 인덱스 메타데이터 구조
```json
{
  "id": "string",
  "name": "string",
  "description": "Agent 판단 근거 (한 줄)",
  "domain": ["BT", "WiFi", "공통"],
  "type": "spec | requirement | confluence | jira",
  "owner": "system | user",
  "ownerId": "string (optional)",
  "accessLevel": "private | team | public",
  "version": "string (optional)"
}
```

### 버전 선택 로직
- 기본: 최신 버전만
- 명시적 버전 언급: 해당 버전
- 비교 질문: 관련 버전 모두

---

## 5. MCP 연동

### 방식 결정
사내 멀티유저 서비스이므로 **SSE 전용**으로 결정.
- stdio: 사용자 수만큼 프로세스 증가 → 멀티유저 부적합
- SSE: URL 연결, 중앙 서버 운영 → 멀티유저 적합

### Tool 등록 시점
- MCP 등록 시: 연결 테스트만
- 세션 시작 시: `tools/list` 호출 → dispatcher 등록
- Tool 호출 시: 실제 MCP 서버 연결

### 핵심 설계 원칙
Agent는 built-in tool과 MCP tool을 구분 없이 동일하게 인식. MCP tool을 Agent용 tool로 래핑해서 등록.

### DB 스키마
```sql
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  headers TEXT,  -- JSON
  env TEXT,      -- JSON
  created_at DATETIME
);
-- tool 목록은 DB 캐싱 안 함 (매번 tools/list 호출)
```

---

## 6. Skill 시스템

### 개념
OpenClaw 방식 참고. SKILL.md 파일 하나로 구성되는 마크다운 기반 워크플로우 지침서.

### 파일 포맷
```markdown
---
name: skill-name
description: 트리거 조건 포함한 설명 (Agent가 언제 사용할지 판단)
tools: ["jira", "gerrit"]
indexes: ["jira-bt"]
persona: ["BT", "WiFi"]
cron: "0 9 * * 1-5"        # 선택사항
cron_notify: "session"     # session | email | webhook
---

# 워크플로우 지침
내용...
```

### Skill Creator
사용자 자연어 설명 → LLM이 SKILL.md 자동 생성 → 확인/수정 → 저장

### Cron Job
주기적 실행 기능 (예: 매일 오전 9시 BT 이슈 변경사항 요약)

**DB 스키마:**
```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT,   -- SKILL.md 전체
  tools TEXT,     -- JSON
  indexes TEXT,   -- JSON
  persona TEXT,   -- JSON
  created_at DATETIME
);

CREATE TABLE cron_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  schedule TEXT NOT NULL,
  notify_type TEXT,       -- session | email | webhook
  notify_target TEXT,
  last_run DATETIME,
  enabled BOOLEAN
);
```

---

## 7. 세션 내 임시 RAG (Local RAG)

### 배경
영구 저장은 웹 서비스 특성상 어려움. 세션 내 임시 RAG로 구현.

### 지원 파일 형식
PDF, PPT, docx, txt (보안 문서는 별도 DRM 확인 필요)

### 처리 흐름
```
파일 업로드
→ 텍스트 추출 (pymupdf, python-pptx, python-docx)
→ 토큰 수 측정
  → 8K 이하: 그냥 컨텍스트에 통째로
  → 8K 초과: 청크 분할 → 사내 임베딩 모델 벡터화 → 세션 메모리 저장
→ search_document tool을 Agent loop에 등록
→ 세션 종료 or TTL 만료 시 메모리 해제
```

### 임베딩
사내 vLLM의 OpenAI 호환 임베딩 API 사용. 코사인 유사도는 numpy로 계산.

---

## 8. Jira 이슈 구조화 지식베이스 (RCA Map)

### 배경 및 목적
기존 Jira RAG index는 이슈 텍스트를 그대로 인덱싱. AI가 한번 정제한 구조화된 지식베이스를 별도로 구축해 검색 품질을 높이는 것이 목표.

이슈들 사이의 관계를 다차원으로 매핑:
- 증상이 같은 이슈
- 원인이 같은 이슈
- Peer 장치가 같은 이슈
- 프로젝트가 같은 이슈
- Test Scenario가 같은 이슈
- Test Binary가 같은 이슈
- 주요 로그 패턴이 같은 이슈

### AI 구조화 문서 형태
```json
{
  "issue_id": "BT-1234",
  "title": "제목 요약",
  "symptoms": ["증상1", "증상2"],
  "root_cause": "근본 원인",
  "peer_device": "연결 장치 모델명",
  "project": "프로젝트/제품명",
  "test_scenario": "테스트 시나리오",
  "test_binary": "테스트 바이너리/버전",
  "log_patterns": ["HCI_ERR_CONNECTION_TIMEOUT", "..."],
  "resolution": "해결 방법 요약",
  "status": "resolved | unresolved | in_progress",
  "keywords": ["검색 키워드"]
}
```

### 로그 기반 유사 이슈 검색 Skill
신규 이슈 발생 시 로그를 입력하면 유사 패턴을 찾아 과거 이슈와 연결.

로그 패턴 정형화는 처음부터 완벽하게 하지 않고 단계적으로:
1. AI가 로그를 자유롭게 읽고 이상해 보이는 것들 추출 (비정형)
2. 결과물이 쌓이면서 자연스럽게 패턴 발견
3. 반복되는 패턴을 정형화해서 추출 로직 고도화

### 배치 처리 전략
- 대상: 최근 2년치 Jira 이슈
- 처리 방식: 기간 지정 + 페이지네이션으로 나눠서 실행
- 이후: 신규/수정 이슈만 주기적으로 업데이트 (Cron)
- 이슈 수에 따른 전략:
  - 500개 이하: 한번에 처리
  - 500~3000개: 배치로 나눠서 처리
  - 3000개 이상: 단계적 처리 (최근 1년 먼저, resolved 이슈 먼저 등)

---

## 9. 구현 우선순위

### 완료
- [x] Flask 완전 제거 → Node.js + Express + better-sqlite3 단일 프로세스
- [x] MCP 서버 등록/연결 (streamable-http/SSE)
- [x] 세션 저장 + Stop 버튼
- [x] RAGaaS 직접 호출 (Flask 프록시 제거)
- [x] Jira/Gerrit 서버 관리 REST API

### 다음
- [ ] RAG 인덱스 메타데이터 + 페르소나별 그룹핑
- [ ] Agent 지능적 인덱스 선택 (2~3개)
- [ ] 세션 내 임시 RAG (파일 업로드 + search_document tool) — Phase 8

### 이후
- [ ] Jira RCA Map 배치 구조화
- [ ] 로그 기반 유사 이슈 검색 Skill
- [ ] Skill Creator

### 나중에
- [ ] Cron Job
- [ ] 보안 문서 DRM 연동 (담당자 확인 필요)

---

## 10. 미해결 이슈

- Tool call 과정/결과 표시가 가끔 안 나오는 버그 (emitStatus race condition 의심)
- 사내 보안 문서 DRM 방식 확인 필요 (Fasoo, MarkAny 등)
- Jira 이슈 총 개수 확인 필요 (배치 전략 수립)
- BT 로그 패턴 정형화 기준 수립 필요
