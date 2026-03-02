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
| 백엔드 API | Python Flask |
| LLM | 사내 vLLM — GLM4.7 / Kimi-K2.5 / GPT-OSS-120B (OpenAI 호환) |
| RAG | 사내 RAGaaS (OpenAI 호환 임베딩) |
| DB | SQLite (`data/connpass.db`) |
| 실시간 통신 | WebSocket (브라우저 ↔ Node.js) |
| MCP | streamable-http / SSE (멀티유저 환경) |

---

## 아키텍처 다이어그램

```
[브라우저 — Vanilla JS]
    ↕ WebSocket (ws://localhost:3000)
[Node.js 서버]  ← pi-agent-core Agent loop (tool call, 세션, 컴팩션)
    ↕ HTTP REST (http://localhost:5000)   ↕ MCP (streamable-http)   ↕ pi-ai (직통)
[Flask app.py]                       [로컬 MCP 서버]           [사내 vLLM]
    ↕                                ├── mcp-atlassian :9001
[RAGaaS] [SQLite]                    └── gerrit-mcp    :9002
```

---

## 디렉토리 구조

```
intellisearch/
├── CLAUDE.md
├── PRD.md / TRD.md / TASKS.md
├── run_flask.py           ← Flask 진입점
│
├── frontend/
│   ├── index.html
│   ├── css/main.css
│   └── js/
│       ├── app.js         ← WebSocket 클라이언트, UI 이벤트
│       ├── chat.js        ← 메시지 렌더링
│       └── settings.js    ← 설정 패널 로직
│
├── server/                ← Node.js Agent 서버 (소스)
│   ├── index.ts           ← WebSocket 서버, 세션 라우팅, X-User-Id 추출
│   ├── agent.ts           ← pi-agent-core 설정, tool 등록, userId 전달
│   ├── models.ts          ← 사내 vLLM 모델 정의
│   ├── translate.ts       ← 번역 모드 (tool 없이 LLM 직통)
│   ├── test.ts            ← 개발용 테스트 스크립트
│   └── tools/
│       ├── mcp.ts         ← MCP 서버 연결 및 tool 래핑
│       ├── rag.ts         ← RAG 검색 tool
│       └── skill.ts       ← 스킬 실행 tool
│
├── api/                   ← Python Flask API
│   ├── app.py             ← before_request: g.user_id = X-User-Id 헤더
│   ├── requirements.txt
│   ├── routes/
│   │   ├── sessions.py    ← 세션 CRUD (user_id 필터)
│   │   ├── mcp.py         ← MCP 서버 관리 (user_id 필터)
│   │   ├── skills.py      ← 스킬 관리 (user_id 필터)
│   │   ├── settings.py    ← 사용자 설정, llm-configs
│   │   ├── rag.py         ← RAG 검색 프록시
│   │   ├── jira.py        ← Jira 서버 관리 (전체 공유)
│   │   └── gerrit.py      ← Gerrit 서버 관리 (전체 공유)
│   └── db/
│       ├── schema.sql     ← CREATE TABLE IF NOT EXISTS (자동 생성)
│       ├── database.py    ← get_db(), init_db()
│       └── migrate_add_user_id.py
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

### 2. Flask는 순수 REST API
Node.js에서 HTTP로 호출. Flask에 WebSocket 붙이지 말 것.

### 3. 번역 모드 = tool 없이 LLM 직통
번역 요청 시 Agent에 tool 등록하지 않고 `pi-ai`의 `streamSimple()` 직접 호출.
RAG/MCP 호출 없음.

### 4. MCP는 SSE 또는 streamable-http
멀티유저 환경이므로 stdio MCP 사용 금지.
세션 시작 시 `tools/list` → Agent tool로 래핑 → 등록.

### 5. SQLite는 Flask에서만 접근
Node.js에서 SQLite 직접 접근 금지. 반드시 Flask API 경유.

### 6. 멀티유저: X-User-Id 헤더
- nginx Reverse Proxy가 인증 후 `X-User-Id` 헤더를 주입
- Flask `before_request` → `g.user_id = request.headers.get("X-User-Id", "default")`
- Node.js WS upgrade 요청에서 `req.headers["x-user-id"] ?? "default"` 추출
- 모든 Flask 호출에 `X-User-Id: <userId>` 헤더 포함
- Jira/Gerrit 서버: 전체 공유 (user_id 없음)
- llm_model_configs: `is_builtin=1` → 전체 공유, `is_builtin=0` → 사용자별 분리

---

## DB 스키마 주요 테이블

| 테이블 | user_id | 비고 |
|--------|---------|------|
| `sessions` | 사용자별 | 메시지 CASCADE 삭제 |
| `messages` | — | session_id FK |
| `mcp_servers` | 사용자별 | |
| `skills` | 사용자별 | enabled=0 soft delete |
| `user_settings` | 사용자별 | PK = user_id |
| `llm_model_configs` | is_builtin=1 공유 / 0 사용자별 | |
| `jira_servers` | 전체 공유 | user_id 없음 |
| `gerrit_servers` | 전체 공유 | user_id 없음 |

DB는 서버 시작 시 `schema.sql` (`CREATE TABLE IF NOT EXISTS`)으로 자동 생성된다.

---

## 환경 변수 (.env)

```env
# Node.js 서버
FLASK_API_URL=http://localhost:5000
WS_PORT=3000

# Flask
VLLM_BASE_URL=http://vllm.internal/v1
VLLM_API_KEY=                    # 사내 vLLM은 키 없이 사용
RAGAAS_URL=http://ragaas.internal
DB_PATH=./data/connpass.db

# 사외 테스트용 (선택)
OPENAI_API_KEY=
```

---

## 실행 방법

### Flask API 서버

```bash
# Python 가상환경 활성화 (WSL2 기준)
source /home/yalexkim/intellisearch-venv/bin/activate

# 프로젝트 루트(intellisearch/)에서 실행
python run_flask.py
# → http://localhost:5000
# 최초 실행 시 data/connpass.db 자동 생성
```

### Node.js Agent 서버

```bash
# WSL2 환경: 반드시 Linux 네이티브 FS에서 실행할 것
# /mnt/c/ 경로에서 실행하면 node_modules I/O가 극도로 느려짐
cd /home/yalexkim/connpass-server
npm run dev
# → ws://localhost:3000
```

> **WSL2 주의사항**: Node.js 서버는 `/home/yalexkim/connpass-server/`에서 실행한다.
> 소스 수정 후에는 Windows 경로의 `server/` 파일을 수정하고, Linux 경로로 동기화해야 한다.
> 동기화: `rsync -a --exclude=node_modules /mnt/c/.../intellisearch/server/ /home/yalexkim/connpass-server/`

---

## WSL2 환경 특이사항

| 항목 | 내용 |
|------|------|
| Python 가상환경 | `/home/yalexkim/intellisearch-venv/` |
| Node.js 실행 경로 | `/home/yalexkim/connpass-server/` (Linux FS) |
| node_modules 위치 | `/home/yalexkim/connpass-server/node_modules/` |
| `@mariozechner/pi-ai` 패치 | `dist/utils/http-proxy.js` → undici 임포트 제거 (WSL2에서 hanging) |

**http-proxy.js 패치 내용** (`npm install` 후 매번 적용 필요):
```js
// http-proxy.js — patched: skip undici EnvHttpProxyAgent (hangs in WSL2)
export {};
```

---

## 사내 vLLM 모델 정의 (pi-ai 방식)

```typescript
import type { Model } from "@mariozechner/pi-ai";

export const models = {
  glm47: {
    id: "GLM4.7",
    api: "openai-completions",
    provider: "internal",
    baseUrl: process.env.VLLM_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  } satisfies Model<"openai-completions">,
  // ... kimiK25, gptOss120b 동일 패턴
};
```

Flask `llm_model_configs` 테이블에서 동적으로 설정 로드 (`resolveModel()`).

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

- `intellisearch/PRD.md` — 제품 요구사항
- `intellisearch/TRD.md` — 기술 설계 상세
- `intellisearch/TASKS.md` — 구현 태스크 목록
- `intellisearch/README.md` — 전체 실행 가이드
- `intellisearch/docs/pi-agent-core-spec.md` — Agent loop 라이브러리 API
- `intellisearch/docs/pi-ai-spec.md` — LLM 통신 라이브러리 API
- `intellisearch/docs/ai-service-architecture.md` — 아키텍처 설계 결정 기록
