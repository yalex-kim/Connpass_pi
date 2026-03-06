# Connpass — BT/WiFi 팀 AI 어시스턴트

BT/WiFi 펌웨어 엔지니어링팀을 위한 사내 전용 AI 채팅 서비스.
자연어로 사내 문서를 검색하고, Jira/Confluence를 조작하고, Gerrit 코드리뷰를 확인할 수 있다.

---

## 아키텍처

### 기술 스택

| 레이어 | 기술 |
|--------|------|
| 프론트엔드 | Vanilla HTML/CSS/JS |
| Agent 엔진 | Node.js + `@mariozechner/pi-agent-core` |
| 백엔드 API | Node.js Express (단일 프로세스, Flask 없음) |
| DB | SQLite (`data/connpass.db`) — `better-sqlite3` 직접 접근 |
| LLM | 사내 vLLM (GLM4.7 / Kimi-K2.5 / GPT-OSS-120B) |
| RAG | 사내 RAGaaS |
| Jira/Confluence | `sooperset/mcp-atlassian` (로컬 MCP 서버) |
| Gerrit | `GerritCodeReview/gerrit-mcp-server` + `supergateway` |

### 전체 시스템 구조

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BROWSER (Vanilla JS)                                │
│                                                                             │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────────────────┐   │
│  │  app.js      │  │  chat.js       │  │  settings.js                 │   │
│  │  (WS클라이언트│  │  (메시지렌더링 │  │  (설정패널: 모델/MCP/Jira/   │   │
│  │   UI이벤트   │  │   마크다운/코드 │  │   Gerrit/RAG/스킬/Agent.md) │   │
│  │   전역state) │  │   하이라이트)  │  │                              │   │
│  └──────┬───────┘  └───────┬────────┘  └──────────────────────────────┘   │
│         │                  │                                                │
│  window.state: { model, indexes, tools, temperature, isTranslateMode ... } │
└──────────┼─────────────────┼──────────────────────────────────────────────┘
           │                 │
           │  WebSocket + HTTP :5001 (X-User-Id 헤더)
           │  WS msg type: chat | translate | stop | sessions.list | sessions.delete
           │
┌──────────▼─────────────────────────────────────────────────────────────────┐
│                     NODE.JS 서버 (server/)                                  │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  index.ts  —  Express + WebSocket 서버                              │   │
│  │                                                                     │   │
│  │  req.headers["x-user-id"] ?? "default"  →  userId                  │   │
│  │  Map<sessionId, { agent, AbortController }>  (세션 상태 관리)        │   │
│  │                                                                     │   │
│  │  chat      →  createAgent()  →  agent.prompt()                      │   │
│  │  translate →  translateDirect()  →  streamSimple() 직통             │   │
│  │  stop      →  controller.abort() + agent.abort()                   │   │
│  └──────────────────┬──────────────────────────────────────────────────┘   │
│                     │                                                       │
│  ┌──────────────────▼──────────────────────────────────────────────────┐   │
│  │  agent.ts  —  pi-agent-core Agent 설정                               │   │
│  │                                                                     │   │
│  │  1. resolveModel()       →  DB (llm_model_configs)                  │   │
│  │  2. buildSystemPrompt()  →  DB (user_settings.agent_md)             │   │
│  │  3. Tool 등록:                                                       │   │
│  │     ├─ ragTool()          (tools/rag.ts)                            │   │
│  │     ├─ getCodingTools()   (tools/coding.ts)                         │   │
│  │     └─ loadAllMcpTools()  (tools/mcp.ts)                            │   │
│  │  4. Agent.subscribe() → WS.send(token | tool_start | tool_end)      │   │
│  └──────────────────┬──────────────────────────────────────────────────┘   │
│                     │                                                       │
│  ┌────────┐  ┌──────┴──────┐  ┌──────────────────────────────────────┐    │
│  │models  │  │translate.ts │  │  tools/                               │    │
│  │.ts     │  │(번역 직통)  │  │  ├─ rag.ts    → RAGaaS 직접 호출     │    │
│  │GLM4.7  │  │streamSimple │  │  ├─ coding.ts → pi-coding-agent       │    │
│  │KimiK2.5│  │()만 호출    │  │  │   (bash/read/write/edit/grep/find) │    │
│  │GPT-OSS │  │             │  │  └─ mcp.ts   → MCP 서버 동적 연결    │    │
│  └────────┘  └─────────────┘  └──────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  routes/   — Express REST API                                        │   │
│  │  ├─ sessions.ts   /api/sessions/*                                   │   │
│  │  ├─ settings.ts   /api/settings/*                                   │   │
│  │  ├─ mcp.ts        /api/mcp/*                                        │   │
│  │  ├─ jira.ts       /api/jira/*                                       │   │
│  │  ├─ gerrit.ts     /api/gerrit/*                                     │   │
│  │  └─ skills.ts     /api/skills/*                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  db.ts  —  better-sqlite3 싱글톤                                     │   │
│  │  schema.sql 자동 실행 (CREATE TABLE IF NOT EXISTS)                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────────────────────┘
                       │
          ┌────────────┼──────────────────────────┐
          │            │                          │
      SQLite       streamSimple()            MCP clients
   직접 접근       vLLM 직통 호출      (StreamableHTTP/SSE)
          │            │                          │
┌─────────▼────┐  ┌────▼──────────────┐  ┌───────▼────────────────┐
│  SQLite DB   │  │  사내 vLLM        │  │  MCP 서버들            │
│  connpass.db │  │                   │  │                        │
│              │  │  OpenAI 호환 API  │  │  ┌─ mcp-atlassian     │
│  사용자별    │  │  ├─ GLM4.7        │  │  │  (Jira) :9001      │
│  격리 포함   │  │  ├─ Kimi-K2.5     │  │  └─ gerrit-mcp        │
│              │  │  └─ GPT-OSS-120B  │  │     :9002             │
└──────────────┘  └───────────────────┘  └────────────────────────┘
```

### 메시지 흐름 (Chat 모드)

```
Browser                  Node.js                  DB / vLLM / MCP
  │                         │                            │
  │──{type:"chat",          │                            │
  │   sessionId, msg,       │                            │
  │   config}──────────────▶│                            │
  │                         │─ loadHistory() ────────────▶ (SQLite 직접)
  │                         │◀─ history ─────────────────│
  │                         │─ saveMessage() ────────────▶ (SQLite 직접)
  │                         │                            │
  │                         │  createAgent()             │
  │                         │  ├─ db.llm_model_configs   │
  │                         │  ├─ db.user_settings       │
  │                         │  └─ tool 등록 완료         │
  │                         │                            │
  │                         │  agent.prompt(msg) ────────▶ vLLM
  │◀─{type:"token",delta}───│◀── text streaming ─────────│
  │◀─{type:"tool_start"}────│                            │
  │                         │  tool 실행 (RAG / MCP / 코딩)
  │◀─{type:"tool_end"}──────│◀─결과 ─────────────────────│
  │                         │  (Agent loop 반복)         │
  │◀─{type:"agent_end"}─────│                            │
  │                         │─ saveMessage() ────────────▶ (SQLite 직접)
  │                         │─ UPDATE sessions title ────▶ (SQLite 직접)
```

### 번역 모드 vs 채팅 모드 분기

```
WebSocket 메시지 수신
        │
        ├── type === "translate"
        │         └── translateDirect()
        │               └── streamSimple() 직통 (tool 없음, Agent 없음)
        │
        └── type === "chat"
                  └── createAgent()
                        └── Agent loop (RAG + Coding + MCP tools)
```

### 멀티유저 격리 (X-User-Id)

```
[nginx reverse proxy]
        │  X-User-Id: user123
        ▼
[Node.js :5001]
        │  req.headers["x-user-id"] ?? "default"  →  userId
        ▼
[각 Route / WS 핸들러]
        ├── sessions / mcp_servers / skills / user_settings
        │         WHERE user_id = 'user123'          ← 사용자별 격리
        │
        └── jira_servers / gerrit_servers            ← 전체 공유 (user_id 없음)
```

---

## 요구 사항

| 도구 | 버전 | 용도 |
|------|------|------|
| Node.js | 20+ | 서버 (Express + WebSocket + SQLite) |
| npm | 10+ | Node.js 패키지 |
| Docker 또는 uv | — | mcp-atlassian 실행 |
| pip | — | gerrit-mcp-server 설치 |
| npx | npm 포함 | supergateway 실행 |

---

## 1단계 — 환경 변수 설정

프로젝트 루트에 `.env` 파일을 생성한다.

```env
# Node.js 서버
WS_PORT=5001
VLLM_BASE_URL=http://vllm.internal/v1
RAGAAS_URL=http://ragaas.internal
DB_PATH=./data/connpass.db

# 사외 테스트용 (선택)
OPENAI_API_KEY=
```

> **참고** Jira/Gerrit 접속 정보는 `.env`가 아닌 설정 UI에서 관리한다.

---

## 2단계 — Node.js 서버 시작

```bash
cd server

# 의존성 설치
npm install

# 개발 모드 (파일 변경 감지)
npm run dev

# 프로덕션
npm start
# → http://localhost:5001 (HTTP + WebSocket)
# 최초 실행 시 data/connpass.db 자동 생성
```

---

## 3단계 — 로컬 MCP 서버 시작

### 3-1. Jira / Confluence (mcp-atlassian)

Atlassian Cloud 계정과 API 토큰이 필요하다.
API 토큰 발급: https://id.atlassian.com/manage-profile/security/api-tokens

**설정 파일 준비**

```bash
cp .env.mcp-atlassian.example .env.mcp-atlassian
```

`.env.mcp-atlassian` 파일을 열어 값을 채운다.

```env
JIRA_URL=https://yourorg.atlassian.net
JIRA_USERNAME=your@email.com
JIRA_API_TOKEN=ATATT3x...

CONFLUENCE_URL=https://yourorg.atlassian.net
CONFLUENCE_USERNAME=your@email.com
CONFLUENCE_API_TOKEN=ATATT3x...
```

**서버 시작**

```bash
# Docker 방식 (권장)
./scripts/start-mcp-atlassian.sh

# 또는 직접 실행 (uv 필요: pip install uv)
source .env.mcp-atlassian
uvx mcp-atlassian --transport streamable-http --stateless --port 9001
```

서버 확인:
```bash
curl -X POST http://localhost:9001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

---

### 3-2. Gerrit (gerrit-mcp-server + supergateway)

**설치**

```bash
pip install gerrit-mcp-server
npm install -g supergateway   # 또는 npx로 자동 설치
```

**설정 파일 준비**

```bash
cp scripts/gerrit_config.json.example scripts/gerrit_config.json
```

`scripts/gerrit_config.json` 파일을 열어 값을 채운다.

```json
{
  "internal_url": "http://gerrit.internal",
  "external_url": "http://gerrit.internal",
  "auth": {
    "type": "http_basic",
    "username": "your-username",
    "password": "your-http-password-or-token"
  }
}
```

**서버 시작**

```bash
./scripts/start-gerrit-mcp.sh
```

---

### 3-3. MCP 서버 등록 (브라우저)

MCP 서버를 시작한 뒤 설정 UI에서 등록해야 Agent가 툴을 인식한다.

1. 브라우저에서 `http://localhost:5001` 접속
2. 설정(⚙) → **MCP 서버 관리** 탭
3. **＋ MCP 서버 추가** 클릭
4. 아래 표대로 각각 등록

| 서버 이름 | URL | Transport |
|---|---|---|
| Jira/Confluence | `http://localhost:9001` | `streamable-http` |
| Gerrit | `http://localhost:9002` | `streamable-http` |

5. **연결 테스트 후 등록** — "ok" 메시지와 툴 개수가 표시되면 성공

---

## 4단계 — 브라우저 접속

```
http://localhost:5001
```

Node.js Express가 `frontend/index.html`을 서빙한다.

---

## 전체 시작 순서 요약

```bash
# 터미널 1 — Node.js (서버 + DB + REST API 통합)
cd server && npm install && npm run dev

# 터미널 2 — Jira/Confluence MCP (선택)
./scripts/start-mcp-atlassian.sh

# 터미널 3 — Gerrit MCP (선택)
./scripts/start-gerrit-mcp.sh
```

---

## 디렉토리 구조

```
Connpass_pi/
├── frontend/               # 브라우저 UI (Vanilla JS)
│   ├── index.html
│   ├── css/main.css
│   └── js/
│       ├── app.js          # WebSocket 클라이언트, UI 이벤트
│       ├── chat.js         # 메시지 렌더링
│       └── settings.js     # 설정 패널 로직
│
├── server/                 # Node.js 서버 (전체 백엔드)
│   ├── index.ts            # Express + WebSocket 서버, 세션 라우팅
│   ├── agent.ts            # pi-agent-core 설정, tool 등록
│   ├── models.ts           # vLLM 모델 정의, DB에서 설정 로드
│   ├── db.ts               # better-sqlite3 싱글톤
│   ├── schema.sql          # DB 스키마 (자동 실행)
│   ├── translate.ts        # 번역 모드
│   ├── routes/
│   │   ├── sessions.ts     # 세션 CRUD + 타이틀 생성
│   │   ├── settings.ts     # 사용자 설정, llm-configs, model-health
│   │   ├── mcp.ts          # MCP 서버 관리 CRUD
│   │   ├── jira.ts         # Jira 서버 관리 + 이슈 조회
│   │   ├── gerrit.ts       # Gerrit 서버 관리 + 변경사항 조회
│   │   └── skills.ts       # 스킬 파일 관리
│   └── tools/
│       ├── mcp.ts          # MCP 서버 연결 (@modelcontextprotocol/sdk)
│       ├── rag.ts          # RAGaaS 직접 호출
│       └── coding.ts       # pi-coding-agent
│
├── scripts/                # MCP 서버 시작 스크립트
│   ├── start-mcp-atlassian.sh
│   ├── start-gerrit-mcp.sh
│   └── gerrit_config.json.example
│
├── docs/                   # 설계 문서 및 스펙
│   ├── mockup.html
│   ├── pi-agent-core-spec.md
│   ├── pi-ai-spec.md
│   ├── pi-coding-agent-spec.md
│   └── ai-service-architecture.md
│
└── data/                   # SQLite DB (자동 생성)
    └── connpass.db
```

---

## Jira 서버 관리 (설정 UI)

설정 → **JIRA 서버** 탭에서 사내 Jira Server(v2)를 별도로 등록할 수 있다.
Atlassian Cloud와 사내 서버를 동시에 등록해서 prefix 기반으로 자동 라우팅된다.

| 필드 | 설명 |
|------|------|
| URL | `https://yourorg.atlassian.net` 또는 `http://jira.internal` |
| 이메일 | Cloud 전용 (Basic Auth) |
| Token | Cloud: API Token / Server: Bearer Token |
| Prefixes | 이슈 키 prefix, 예: `BT,WLAN,SDK` |

URL에 `atlassian.net` 또는 `atlassian.com`이 포함되면 Cloud(v3 API)로, 그 외는 사내 Server(v2 API)로 자동 판별한다.

---

## 주요 API 엔드포인트

### 세션 관리
```
GET    /api/sessions                   # 목록
POST   /api/sessions                   # 생성
GET    /api/sessions/<id>              # 조회 (메시지 포함)
PATCH  /api/sessions/<id>              # 수정
DELETE /api/sessions/<id>              # 삭제
POST   /api/sessions/generate-title    # LLM 제목 생성
```

### MCP 서버 관리
```
GET    /api/mcp/servers                # 목록
POST   /api/mcp/servers                # 등록 (name, url, transport)
DELETE /api/mcp/servers/<id>           # 삭제
POST   /api/mcp/servers/<id>/test      # 연결 테스트
```

### Jira 서버 관리
```
GET    /api/jira/servers               # 목록
POST   /api/jira/servers               # 등록
DELETE /api/jira/servers/<id>          # 삭제
POST   /api/jira/servers/<id>/test     # 연결 테스트
GET    /api/jira/projects              # 프로젝트 목록
```

### 기타
```
GET    /health                         # 헬스체크
GET    /api/settings                   # 사용자 설정
GET    /api/settings/model-health      # 모델 헬스체크
```

---

## 문제 해결

### MCP 서버 연결 실패
- MCP 서버가 실행 중인지 확인: `curl http://localhost:9001/mcp`
- 포트 충돌 확인: `lsof -i :9001`
- Docker 방식이면 컨테이너 로그 확인: `docker logs <container_id>`

### Node.js 서버 오류
- `data/` 디렉토리 쓰기 권한 확인
- Node.js 버전 확인: `node --version` (20 이상 필요)
- `server/` 디렉토리에서 `npm install` 후 재시작

### Atlassian API 401
- API Token이 만료됐거나 잘못됨 → https://id.atlassian.com/manage-profile/security/api-tokens 에서 재발급
- 이메일 주소가 Atlassian 계정 이메일과 일치하는지 확인
