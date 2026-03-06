# Connpass — CLAUDE.md
> BT/WiFi 엔지니어링팀 사내 LLM + RAG 기반 AI 어시스턴트
> Claude Code가 이 파일을 읽고 프로젝트 전체 맥락을 파악한다.

---

## 프로젝트 한 줄 요약

엔지니어가 자연어로 BT/WiFi 문서를 검색하고, Jira/Gerrit을 조작하고, 반복 업무를 자동화할 수 있는 사내 전용 AI 채팅 서비스.

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 프론트엔드 | Vanilla HTML/CSS/JS |
| Agent 엔진 | Node.js + `@mariozechner/pi-agent-core` (MIT) |
| 백엔드 API | Node.js Express (Python Flask 제거) |
| LLM | 사내 vLLM — GLM4.7 / Kimi-K2.5 / GPT-OSS-120B (OpenAI 호환) |
| RAG | 사내 RAGaaS (OpenAI 호환 임베딩) |
| DB | SQLite (`data/connpass.db`) — `better-sqlite3`로 Node.js에서 직접 접근 |
| 실시간 통신 | WebSocket (브라우저 ↔ Node.js) |
| MCP | streamable-http / SSE (멀티유저 환경) |

---

## 아키텍처 다이어그램

```
[브라우저 — Vanilla JS]
    ↕ WebSocket + HTTP (localhost:5001)
[Node.js 서버 — Express + WebSocket]
    ├── pi-agent-core Agent loop (tool call, 세션, 컴팩션)
    ├── SQLite (better-sqlite3 직접 접근)
    ├── RAGaaS 직접 호출
    ↕ MCP (streamable-http)        ↕ pi-ai (직통)
[로컬 MCP 서버]                  [사내 vLLM]
├── mcp-atlassian :9001
└── gerrit-mcp    :9002
```

> Python Flask는 완전히 제거됨. 필요 시 FastAPI를 MCP 서버로 추가.

---

## 디렉토리 구조

```
Connpass_pi/
├── CLAUDE.md
├── PRD.md / TRD.md / TASKS.md
│
├── frontend/
│   ├── index.html
│   ├── css/main.css
│   └── js/
│       ├── app.js         ← WebSocket 클라이언트, UI 이벤트
│       ├── chat.js        ← 메시지 렌더링
│       └── settings.js    ← 설정 패널 로직
│
├── server/                ← Node.js 서버 (소스)
│   ├── index.ts           ← Express + WebSocket 서버, 세션 라우팅
│   ├── agent.ts           ← pi-agent-core 설정, tool 등록
│   ├── models.ts          ← vLLM 모델 정의, DB에서 설정 로드
│   ├── db.ts              ← better-sqlite3 초기화, schema.sql 실행
│   ├── schema.sql         ← DB 스키마 (CREATE TABLE IF NOT EXISTS)
│   ├── translate.ts       ← 번역 모드 (tool 없이 LLM 직통)
│   ├── test.ts            ← 개발용 테스트 스크립트
│   ├── routes/
│   │   ├── sessions.ts    ← 세션 CRUD + 타이틀 생성
│   │   ├── settings.ts    ← 사용자 설정, llm-configs, model-health
│   │   ├── mcp.ts         ← MCP 서버 관리
│   │   ├── jira.ts        ← Jira 서버 관리 + 이슈 조회
│   │   ├── gerrit.ts      ← Gerrit 서버 관리 + 변경사항 조회
│   │   └── skills.ts      ← 스킬 파일 관리
│   └── tools/
│       ├── mcp.ts         ← MCP 서버 연결 및 tool 래핑
│       ├── rag.ts         ← RAGaaS 직접 호출 tool
│       └── coding.ts      ← 파일시스템 tool
│
├── scripts/               ← MCP 서버 시작 스크립트
│   ├── start-mcp-atlassian.sh
│   ├── start-gerrit-mcp.sh
│   └── gerrit_config.json.example
│
├── data/                  ← SQLite DB (서버 시작 시 자동 생성)
│   └── connpass.db
│
└── docs/
    ├── mockup.html
    ├── pi-agent-core-spec.md
    ├── pi-ai-spec.md
    ├── pi-coding-agent-spec.md
    └── ai-service-architecture.md
```

---

## 핵심 구현 규칙

### 1. Agent loop는 pi-agent-core에 위임
직접 tool call 루프 구현 금지. `Agent` 클래스가 자동으로:
- tool call 실행 → 결과 피드백 → 반복
- 컨텍스트 컴팩션
- AbortController로 Stop 처리

### 2. Express는 REST API + 정적 파일 서빙
Node.js 단일 프로세스. 별도 백엔드 서버 없음.

### 3. 번역 모드 = tool 없이 LLM 직통
번역 요청 시 Agent에 tool 등록하지 않고 `pi-ai`의 `streamSimple()` 직접 호출.

### 4. MCP는 SSE 또는 streamable-http
멀티유저 환경이므로 stdio MCP 사용 금지.
세션 시작 시 `tools/list` → Agent tool로 래핑 → 등록.

### 5. SQLite는 better-sqlite3로 Node.js에서 직접 접근
Python 없음. `server/db.ts`에서 싱글톤 DB 인스턴스 관리.

### 6. 멀티유저: X-User-Id 헤더
- nginx Reverse Proxy가 인증 후 `X-User-Id` 헤더를 주입
- Node.js WS upgrade / Express 요청에서 `req.headers["x-user-id"] ?? "default"` 추출
- Jira/Gerrit 서버: 전체 공유 (user_id 없음)
- llm_model_configs: `is_builtin=1` → 전체 공유, `is_builtin=0` → 사용자별 분리

### 7. Python이 필요한 툴은 FastAPI MCP 서버로 추가
Flask 재도입 금지. Python 전용 연산(numpy, pandas 등)이 필요하면 FastAPI로 MCP 서버 구현 후 등록.

---

## DB 스키마 주요 테이블

| 테이블 | user_id | 비고 |
|--------|---------|------|
| `sessions` | 사용자별 | 메시지 CASCADE 삭제 |
| `messages` | — | session_id FK |
| `mcp_servers` | 사용자별 | |
| `user_settings` | 사용자별 | PK = user_id |
| `llm_model_configs` | is_builtin=1 공유 / 0 사용자별 | |
| `jira_servers` | 전체 공유 | user_id 없음 |
| `gerrit_servers` | 전체 공유 | user_id 없음 |

DB는 서버 시작 시 `server/schema.sql` (`CREATE TABLE IF NOT EXISTS`)으로 자동 생성된다.

---

## 환경 변수 (.env)

```env
# Node.js 서버
WS_PORT=5001
VLLM_BASE_URL=http://vllm.internal/v1
RAGAAS_URL=http://ragaas.internal
DB_PATH=./data/connpass.db

# 사외 테스트용 (선택)
OPENAI_API_KEY=
```

---

## 실행 방법

### Node.js 서버 (단일 프로세스)

```bash
# WSL2 환경: 반드시 Linux 네이티브 FS에서 실행할 것
cd /home/yalexkim/connpass-server
npm install          # better-sqlite3, multer 포함
npm run dev
# → http://localhost:5001 (HTTP + WebSocket)
# 최초 실행 시 data/connpass.db 자동 생성
```

> **WSL2 주의사항**: Node.js 서버는 `/home/yalexkim/connpass-server/`에서 실행한다.
> 동기화: `rsync -a --exclude=node_modules /mnt/c/.../server/ /home/yalexkim/connpass-server/`

---

## WSL2 환경 특이사항

| 항목 | 내용 |
|------|------|
| Node.js 실행 경로 | `/home/yalexkim/connpass-server/` (Linux FS) |
| node_modules 위치 | `/home/yalexkim/connpass-server/node_modules/` |
| `@mariozechner/pi-ai` 패치 | `dist/utils/http-proxy.js` → undici 임포트 제거 (WSL2에서 hanging) |

**http-proxy.js 패치 내용** (`npm install` 후 매번 적용 필요):
```js
// http-proxy.js — patched: skip undici EnvHttpProxyAgent (hangs in WSL2)
export {};
```

---

## 사내 vLLM 모델 정의

SQLite `llm_model_configs` 테이블에서 동적으로 설정 로드 (`resolveModel()`).
`server/schema.sql`에 GLM4.7, Kimi-K2.5, GPT-OSS-120B 기본값 삽입.

---

## UI 목업 참조

`docs/mockup.html` — 완성된 UI 목업. 아래 특징 유지:
- Dark 테마, IBM Plex Mono/Sans KR 폰트
- Industrial/Utilitarian 디자인
- 데스크탑 전용 (반응형 불필요)
- 사이드바(260px) + 채팅영역 2분할
- 설정은 채팅 영역 내 전환 (별도 페이지 없음)
- 번역 모드: 입력창 우측 `⟵⟶ 번역` 토글

---

## 관련 문서

- `PRD.md` — 제품 요구사항
- `TRD.md` — 기술 설계 상세
- `TASKS.md` — 구현 태스크 목록
- `docs/pi-agent-core-spec.md` — Agent loop 라이브러리 API
- `docs/pi-ai-spec.md` — LLM 통신 라이브러리 API
- `docs/ai-service-architecture.md` — 아키텍처 설계 결정 기록
