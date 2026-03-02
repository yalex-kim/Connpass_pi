# Connpass — BT/WiFi 팀 AI 어시스턴트

BT/WiFi 펌웨어 엔지니어링팀을 위한 사내 전용 AI 채팅 서비스.
자연어로 사내 문서를 검색하고, Jira/Confluence를 조작하고, Gerrit 코드리뷰를 확인할 수 있다.

---

## 아키텍처

```
[브라우저 — Vanilla JS]
    ↕ WebSocket
[Node.js 서버]  ← pi-agent-core Agent loop
    ↕ HTTP REST              ↕ MCP (streamable-http)
[Flask API]          [로컬 MCP 서버]
    ↕                    ├── mcp-atlassian :9001  → Atlassian Cloud (Jira, Confluence)
[SQLite DB]              └── gerrit-mcp    :9002  → 사내 Gerrit
```

| 레이어 | 기술 |
|--------|------|
| 프론트엔드 | Vanilla HTML/CSS/JS |
| Agent 엔진 | Node.js + `@mariozechner/pi-agent-core` |
| 백엔드 API | Python Flask |
| LLM | 사내 vLLM (GLM4.7 / Kimi-K2.5 / GPT-OSS-120B) |
| RAG | 사내 RAGaaS |
| DB | SQLite |
| Jira/Confluence | `sooperset/mcp-atlassian` (로컬 MCP 서버) |
| Gerrit | `GerritCodeReview/gerrit-mcp-server` + `supergateway` |

---

## 요구 사항

| 도구 | 버전 | 용도 |
|------|------|------|
| Python | 3.11+ | Flask API |
| Node.js | 20+ | Agent 서버 |
| npm | 10+ | Node.js 패키지 |
| Docker 또는 uv | — | mcp-atlassian 실행 |
| pip | — | gerrit-mcp-server 설치 |
| npx | npm 포함 | supergateway 실행 |

---

## 1단계 — 환경 변수 설정

프로젝트 루트에 `.env` 파일을 생성한다. `.env.example`을 복사해서 시작한다.

```bash
cp .env.example .env
```

```env
# Node.js 서버
FLASK_API_URL=http://localhost:5000
WS_PORT=3000

# Flask
VLLM_BASE_URL=http://vllm.internal/v1
VLLM_API_KEY=
RAGAAS_URL=http://ragaas.internal
DB_PATH=./data/connpass.db
```

> **참고** Jira/Gerrit 접속 정보는 `.env`가 아닌 설정 UI와 MCP 서버 설정 파일에서 관리한다.

---

## 2단계 — Flask API 서버 시작

```bash
# 의존성 설치
pip install -r api/requirements.txt

# 서버 시작
python run_flask.py
# → http://localhost:5000
```

첫 실행 시 `data/connpass.db`가 자동으로 생성된다.

---

## 3단계 — Node.js Agent 서버 시작

```bash
cd server

# 의존성 설치
npm install

# 개발 모드 (파일 변경 감지)
npm run dev

# 프로덕션
npm start
# → ws://localhost:3000
```

---

## 4단계 — 로컬 MCP 서버 시작

### 4-1. Jira / Confluence (mcp-atlassian)

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

### 4-2. Gerrit (gerrit-mcp-server + supergateway)

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

### 4-3. MCP 서버 등록 (브라우저)

MCP 서버를 시작한 뒤 설정 UI에서 등록해야 Agent가 툴을 인식한다.

1. 브라우저에서 `http://localhost:5000` 접속
2. 설정(⚙) → **MCP 서버 관리** 탭
3. **＋ MCP 서버 추가** 클릭
4. 아래 표대로 각각 등록

| 서버 이름 | URL | Transport |
|---|---|---|
| Jira/Confluence | `http://localhost:9001` | `streamable-http` |
| Gerrit | `http://localhost:9002` | `streamable-http` |

5. **연결 테스트 후 등록** — "ok" 메시지와 툴 개수가 표시되면 성공

---

## 5단계 — 브라우저 접속

```
http://localhost:5000
```

Flask가 `frontend/index.html`을 서빙한다. WebSocket은 `ws://localhost:3000`으로 자동 연결된다.

---

## 전체 시작 순서 요약

```bash
# 터미널 1 — Flask
pip install -r api/requirements.txt
python run_flask.py

# 터미널 2 — Node.js Agent
cd server && npm install && npm run dev

# 터미널 3 — Jira/Confluence MCP
./scripts/start-mcp-atlassian.sh

# 터미널 4 — Gerrit MCP
./scripts/start-gerrit-mcp.sh
```

---

## 디렉토리 구조

```
connpass/
├── frontend/               # 브라우저 UI (Vanilla JS)
│   ├── index.html
│   ├── css/main.css
│   └── js/
│       ├── app.js          # WebSocket 클라이언트, UI 이벤트
│       ├── chat.js         # 메시지 렌더링
│       └── settings.js     # 설정 패널 로직
│
├── server/                 # Node.js Agent 서버
│   ├── index.ts            # WebSocket 서버
│   ├── agent.ts            # pi-agent-core 설정, MCP 툴 로드
│   ├── models.ts           # 사내 vLLM 모델 정의
│   ├── translate.ts        # 번역 모드
│   └── tools/
│       ├── mcp.ts          # MCP 서버 연결 (@modelcontextprotocol/sdk)
│       ├── rag.ts          # RAG 검색
│       └── skill.ts        # 스킬 실행
│
├── api/                    # Python Flask API
│   ├── app.py
│   ├── routes/
│   │   ├── sessions.py
│   │   ├── mcp.py          # MCP 서버 관리 CRUD
│   │   ├── skills.py
│   │   ├── settings.py
│   │   ├── rag.py
│   │   ├── jira.py         # Jira 서버 관리 CRUD
│   │   └── gerrit.py       # Gerrit 서버 관리 CRUD
│   ├── db/
│   │   ├── schema.sql
│   │   ├── database.py
│   │   └── migrate_add_user_id.py
│   └── requirements.txt
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
├── data/                   # SQLite DB (자동 생성)
├── .env.example
├── .env.mcp-atlassian.example
└── run_flask.py
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
```

---

## 문제 해결

### MCP 서버 연결 실패
- MCP 서버가 실행 중인지 확인: `curl http://localhost:9001/mcp`
- 포트 충돌 확인: `lsof -i :9001`
- Docker 방식이면 컨테이너 로그 확인: `docker logs <container_id>`

### Flask 서버 오류
- `data/` 디렉토리 쓰기 권한 확인
- Python 버전 확인: `python3 --version` (3.11 이상 필요)

### Node.js 연결 오류
- Flask가 먼저 실행 중인지 확인 (`http://localhost:5000/health`)
- `server/.env` 또는 루트 `.env`의 `FLASK_API_URL` 확인

### Atlassian API 401
- API Token이 만료됐거나 잘못됨 → https://id.atlassian.com/manage-profile/security/api-tokens 에서 재발급
- 이메일 주소가 Atlassian 계정 이메일과 일치하는지 확인
