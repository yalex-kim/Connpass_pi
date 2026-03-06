# 아키텍처 개선 항목

> 작성일: 2026-03-06
> 기준 브랜치: `claude/code-architecture-diagram-clBEC` (Flask 제거 완료 시점)

---

## 현재 상태 요약

| 개선 항목 | 상태 |
|-----------|------|
| RAG 검색 경로 이중 프록시 제거 | ✅ 완료 (`tools/rag.ts` → RAGaaS 직접 호출) |
| SQLite WAL 모드 | ✅ 완료 (`server/schema.sql` PRAGMA journal_mode=WAL) |
| tools/mcp.ts FLASK_URL 잔존 | ❌ **버그** — 즉시 수정 필요 |
| Coding tools 파일시스템 격리 | ❌ 미구현 — 보안 HIGH |
| X-User-Id 접근 제어 | ❌ 미구현 — 보안 HIGH |
| MCP 연결 캐싱 | ❌ 미구현 — 성능 |
| 모델 설정 캐싱 | ❌ 미구현 — 성능 (DB 직접 조회로 완화됨) |
| Agent 세션 재시작 복구 | ❌ 미구현 — 안정성 |
| 헬스체크/재시도 | ❌ 미구현 — 안정성 |

---

## 즉시 수정 필요 (버그)

### tools/mcp.ts — FLASK_URL 잔존

**위치**: `server/tools/mcp.ts:7`, `server/tools/mcp.ts:80`

```typescript
// 현재 코드 (버그)
const FLASK_URL = process.env.FLASK_API_URL ?? "http://localhost:5000";
// ...
const res = await fetch(`${FLASK_URL}/api/mcp/servers`, { headers: { "X-User-Id": userId } });
```

Flask가 제거됐으므로 이 fetch는 항상 실패한다. MCP 서버 목록을 DB에서 직접 읽어야 한다.

**수정 방향**:
```typescript
// server/tools/mcp.ts
import db from "../db.js";

export async function loadAllMcpTools(userId = "default") {
  const servers = db.prepare(
    "SELECT id, name, url, transport, enabled FROM mcp_servers WHERE user_id = ? AND enabled = 1"
  ).all(userId) as McpServerConfig[];
  // ...
}
```

---

## 보안 — 높음

### 1. Coding tools 파일시스템 격리

**위치**: `server/agent.ts:87`

```typescript
// 현재 코드 — 모든 유저가 서버의 동일한 process.cwd() 공유
toolList.push(...getCodingTools());
```

**문제**: 멀티유저 환경에서 한 유저가 bash/read/write/edit tool을 통해 다른 유저의 작업 파일이나 서버 파일에 접근/수정 가능.

**수정 방향 (선택지)**:

Option A — 유저별 샌드박스 디렉토리 지정:
```typescript
import { mkdirSync } from "fs";
const sandboxDir = `/tmp/connpass/${userId}`;
mkdirSync(sandboxDir, { recursive: true });
toolList.push(...getCodingTools(sandboxDir));
```

Option B — Coding tools 비활성화 (사내 서비스 특성상 실익 낮으면):
```typescript
// config.tools.includes("coding") 조건으로 명시적으로 켤 때만 활성화
if (config.tools.includes("coding")) {
  toolList.push(...getCodingTools(`/tmp/connpass/${userId}`));
}
```

> `getCodingTools()`의 cwd 파라미터 시그니처는 `docs/pi-coding-agent-spec.md` 확인.

---

### 2. X-User-Id 접근 제어

**문제**: Node.js(:5001)에 직접 접근하면 `X-User-Id: admin` 등 임의 userId 사용 가능. nginx만 신뢰하지 않음.

**수정 방향 (선택지)**:

Option A — 방화벽으로 외부에서 :5001 직접 접근 차단 (nginx만 허용):
```
# iptables / ufw 예시
ufw deny 5001
ufw allow from 127.0.0.1 to any port 5001
```

Option B — nginx ↔ Node.js 간 내부 공유 시크릿 헤더 검증:
```typescript
// server/index.ts — Express 미들웨어 추가
const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
if (INTERNAL_SECRET) {
  app.use((req, res, next) => {
    if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  });
}
```
```nginx
# nginx.conf
proxy_set_header X-Internal-Secret $INTERNAL_SECRET;
```

**권장**: 내부망 서비스라면 Option A(방화벽)이 가장 단순하고 확실함.

---

## 성능 — 중간

### 3. MCP 연결 캐싱

**위치**: `server/tools/mcp.ts`

**현재 흐름** (채팅 메시지마다):
```
createAgent()
  → loadAllMcpTools(userId)
    → DB에서 서버 목록 조회
    → 각 MCP 서버에 새 TCP 연결 (tools/list 조회용)
    → 연결 종료
  → [tool 실행 시]
    → 또 새 TCP 연결
    → tool call
    → 연결 종료
```

**수정 방향** — userId별 연결 풀 캐싱:
```typescript
// server/tools/mcp.ts
const clientPool = new Map<string, { client: Client; expiresAt: number }>();
const POOL_TTL_MS = 5 * 60 * 1000; // 5분

async function getOrCreateClient(server: McpServerConfig): Promise<Client> {
  const key = server.id;
  const cached = clientPool.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.client;

  const client = await connectClient(server);
  clientPool.set(key, { client, expiresAt: Date.now() + POOL_TTL_MS });
  return client;
}

// MCP 서버 설정 변경 시 해당 캐시 무효화
export function invalidateMcpClient(serverId: string) {
  clientPool.delete(serverId);
}
```

`routes/mcp.ts`의 서버 삭제/수정 시 `invalidateMcpClient(serverId)` 호출.

---

### 4. 모델 설정 캐싱

**위치**: `server/models.ts` — `resolveModel()`

**현재**: 채팅 메시지마다 `db.prepare(...).get(modelId)` 실행.
**현황**: Flask HTTP 호출에서 better-sqlite3 동기 DB 읽기로 이미 크게 개선됨. 레이턴시 영향은 미미.

**수정 방향** (필요 시):
```typescript
// server/models.ts
const configCache = new Map<string, { value: LlmModelConfig; expiresAt: number }>();
const CONFIG_TTL_MS = 30_000; // 30초

export async function resolveModel(modelId: string) {
  const cached = configCache.get(modelId);
  if (cached && cached.expiresAt > Date.now()) {
    // 캐시 히트 — cached.value로 model 구성
  }
  const cfg = db.prepare("SELECT * FROM llm_model_configs WHERE model_id = ?").get(modelId);
  if (cfg) configCache.set(modelId, { value: cfg, expiresAt: Date.now() + CONFIG_TTL_MS });
  // ...
}
```

> 우선순위 낮음. DB 설정 변경 시 최대 30초 지연 허용 가능한지 확인 후 적용.

---

## 안정성 — 낮음

### 5. Node.js 재시작 시 Agent 세션 소실

**위치**: `server/index.ts`

```typescript
// 현재 — 메모리에만 존재
const sessions = new Map<string, SessionState>();
```

**문제**: 재시작 시 진행 중이던 응답이 소실되고 클라이언트는 응답 없이 무한 대기.

**수정 방향** — 생성 중 상태 DB 기록:
```typescript
// server/schema.sql 에 컬럼 추가
ALTER TABLE sessions ADD COLUMN generating INTEGER DEFAULT 0;

// server/index.ts — 채팅 시작/종료 시 상태 기록
db.prepare("UPDATE sessions SET generating = 1 WHERE id = ?").run(sessionId);
// ... 생성 완료/실패 후
db.prepare("UPDATE sessions SET generating = 0 WHERE id = ?").run(sessionId);

// 서버 시작 시 generating=1인 세션들에 대해 오류 메시지 저장
db.prepare("SELECT id FROM sessions WHERE generating = 1").all().forEach(({ id }) => {
  saveMessage(id, "assistant", "서버가 재시작되어 응답이 중단되었습니다. 다시 질문해 주세요.");
  db.prepare("UPDATE sessions SET generating = 0 WHERE id = ?").run(id);
});
```

> WebSocket이 끊기면 클라이언트는 재연결 시 sessions.list로 상태를 복구할 수 있으므로,
> 최소한 "응답 실패" 메시지를 DB에 남기는 것만으로도 충분함.

---

### 6. 헬스체크 / 재시도

**현재**: vLLM, RAGaaS 장애 시 즉시 실패. 재시도 없음.

**수정 방향**:

```typescript
// server/utils/retry.ts (신규)
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
  baseDelayMs = 1000
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok || resp.status < 500) return resp;
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw new Error("unreachable");
}
```

적용 대상:
- `server/tools/rag.ts` — RAGaaS 검색 실패 시 1~2회 재시도
- `server/routes/sessions.ts` — generate-title LLM 호출 (이미 실패 시 첫 30자로 폴백)

---

## 우선순위 요약

| 순위 | 항목 | 이유 |
|------|------|------|
| 🔴 즉시 | tools/mcp.ts FLASK_URL 버그 | MCP 기능 전체 불동작 |
| 🔴 높음 | Coding tools 파일시스템 격리 | 멀티유저 보안 직결 |
| 🟡 높음 | X-User-Id 접근 제어 | 인증 우회 가능 (내부망이면 방화벽으로 해결) |
| 🟠 중간 | MCP 연결 캐싱 | 응답 지연 개선 |
| ⚪ 낮음 | Agent 세션 재시작 복구 | 재시작 빈도 낮으면 영향 적음 |
| ⚪ 낮음 | 헬스체크/재시도 | RAGaaS/vLLM 가용성에 따라 우선순위 조정 |
| ⚪ 낮음 | 모델 설정 캐싱 | DB 직접 조회로 이미 빠름 |

---

## 이미 해결된 항목

| 항목 | 커밋 | 내용 |
|------|------|------|
| RAG 이중 프록시 제거 | `f19c093` | `tools/rag.ts` → RAGaaS 직접 호출 |
| SQLite WAL 모드 | `2bce011` | `server/schema.sql` PRAGMA journal_mode=WAL |
| Flask 전체 제거 | `2bce011` | Node.js Express + better-sqlite3 단일 프로세스 |
