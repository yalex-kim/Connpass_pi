# 컴팩션 히스토리 보존 구현 계획

## 배경 및 문제

현재 `server/compaction.ts`는 컴팩션 발생 시 오래된 메시지를 DB에서 **DELETE**한다.
`GET /api/sessions/:id`는 `messages` 테이블을 그대로 UI에 반환하므로, 유저가 사이드바에서
이전 세션을 다시 열면 컴팩션된 메시지들이 사라져 보이는 문제가 있다.

### 관심사 분리

| 관심사 | 목표 |
|--------|------|
| Agent 컨텍스트 | 토큰 한도 내로 유지 (컴팩션 필요) |
| 유저 히스토리 UI | 원본 메시지 전체를 항상 볼 수 있어야 함 |

두 관심사를 같은 `messages` 테이블로 처리하되, 플래그로 구분한다.

---

## 설계

### 1. DB 스키마 변경 (`server/schema.sql`)

`messages` 테이블에 컬럼 2개 추가:

```sql
ALTER TABLE messages ADD COLUMN is_compacted INTEGER NOT NULL DEFAULT 0;
-- 0: 정상 메시지 (Agent에 포함)
-- 1: 컴팩션됨 (Agent 로드 시 제외, UI에는 표시)

ALTER TABLE messages ADD COLUMN is_summary   INTEGER NOT NULL DEFAULT 0;
-- 0: 일반 메시지
-- 1: 컴팩션 요약 메시지 (UI에서 접힘 표시)
```

> **`schema.sql` 수정 방법**: `CREATE TABLE IF NOT EXISTS messages` 정의에 두 컬럼을 추가한다.
> 이미 DB가 생성된 환경에서는 서버 시작 시 마이그레이션 코드도 필요하다(아래 참조).

---

### 2. 마이그레이션 (`server/db.ts`)

`schema.sql` 실행 후, 기존 DB에 컬럼이 없을 수 있으므로 아래 코드를 추가한다:

```typescript
// db.ts — schema 실행 직후
const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
const colNames = cols.map(c => c.name);
if (!colNames.includes("is_compacted")) {
  db.prepare("ALTER TABLE messages ADD COLUMN is_compacted INTEGER NOT NULL DEFAULT 0").run();
}
if (!colNames.includes("is_summary")) {
  db.prepare("ALTER TABLE messages ADD COLUMN is_summary INTEGER NOT NULL DEFAULT 0").run();
}
```

---

### 3. `server/compaction.ts` 변경

#### 3-1. `MsgRow` 타입에 새 컬럼 포함

```typescript
interface MsgRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
  is_compacted: number;  // 추가
  is_summary: number;    // 추가
}
```

#### 3-2. 쿼리 변경: `is_compacted = 0`인 메시지만 대상으로

```typescript
// 변경 전
const rows = db.prepare(
  "SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC"
).all(sessionId) as MsgRow[];

// 변경 후
const rows = db.prepare(
  `SELECT id, role, content, created_at, is_compacted, is_summary
   FROM messages
   WHERE session_id = ? AND is_compacted = 0
   ORDER BY created_at ASC`
).all(sessionId) as MsgRow[];
```

#### 3-3. DB 트랜잭션: DELETE → UPDATE + INSERT

```typescript
// 변경 전
db.transaction(() => {
  const placeholders = toSummarize.map(() => "?").join(",");
  db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...toSummarize.map(r => r.id));

  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(summaryMsgId, sessionId, "user", JSON.stringify(`[이전 대화 ...`), summaryTime);
})();

// 변경 후
db.transaction(() => {
  // DELETE 대신 is_compacted = 1 플래그만 설정
  const placeholders = toSummarize.map(() => "?").join(",");
  db.prepare(
    `UPDATE messages SET is_compacted = 1 WHERE id IN (${placeholders})`
  ).run(...toSummarize.map(r => r.id));

  // 요약 메시지 삽입 — is_summary = 1 플래그 포함
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at, is_compacted, is_summary)
     VALUES (?, ?, ?, ?, ?, 0, 1)`
  ).run(summaryMsgId, sessionId, "user", JSON.stringify(`[이전 대화 ${toSummarize.length}개 요약]\n${summaryText}`), summaryTime);
})();
```

---

### 4. `server/index.ts` — `loadHistory()` 변경

Agent에 로드하는 히스토리는 `is_compacted = 0`인 것만 가져온다.

```typescript
// 변경 전 (추정 — loadHistory 함수 위치 확인 필요)
function loadHistory(sessionId: string) {
  return db.prepare(
    "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC"
  ).all(sessionId);
}

// 변경 후
function loadHistory(sessionId: string) {
  return db.prepare(
    `SELECT role, content FROM messages
     WHERE session_id = ? AND is_compacted = 0
     ORDER BY created_at ASC`
  ).all(sessionId);
}
```

---

### 5. `server/routes/sessions.ts` — UI API 변경

`GET /api/sessions/:id`는 **전체 메시지**를 반환하되, `is_compacted`와 `is_summary` 필드를 포함시켜 UI가 구분할 수 있도록 한다.

```typescript
// 변경 전
const messages = db.prepare(
  "SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC"
).all(req.params.id);

// 변경 후
const messages = db.prepare(
  `SELECT id, role, content, created_at, is_compacted, is_summary
   FROM messages WHERE session_id = ? ORDER BY created_at ASC`
).all(req.params.id);
```

응답 JSON 예시:
```json
[
  { "id": "...", "role": "user",      "content": "안녕",      "is_compacted": 1, "is_summary": 0 },
  { "id": "...", "role": "assistant", "content": "안녕하세요", "is_compacted": 1, "is_summary": 0 },
  { "id": "...", "role": "user",      "content": "[요약] ...", "is_compacted": 0, "is_summary": 1 },
  { "id": "...", "role": "user",      "content": "다음 질문", "is_compacted": 0, "is_summary": 0 }
]
```

---

### 6. `frontend/js/chat.js` — 요약 블록 렌더링 추가

`ChatRenderer`에 요약 메시지 전용 렌더링 함수를 추가한다.
기존 `addCompactionBlock()`과 유사하지만, 요약 텍스트를 **접기/펼치기** 아코디언으로 표시한다.

```javascript
// chat.js — ChatRenderer 객체에 추가

addSummaryBlock(summaryText) {
  const block = document.createElement('div');
  block.className = 'block--compaction';

  // 요약 텍스트: "[이전 대화 N개 요약]\n실제 요약 내용" 형태
  // "[이전 대화 N개 요약]" 헤더 파싱
  const lines = summaryText.split('\n');
  const header = lines[0] || '이전 대화 요약';
  const body   = lines.slice(1).join('\n').trim();
  const bodyId = 'summary-body-' + Date.now();

  block.innerHTML =
    '<div class="compaction-divider"></div>' +
    '<div class="summary-accordion">' +
      '<div class="summary-accordion-head" role="button" aria-expanded="false" data-target="' + bodyId + '">' +
        '<span>&#x26A1; ' + this._escapeHtml(header) + '</span>' +
        '<span class="tool-chevron">&#9658;</span>' +
      '</div>' +
      '<div class="summary-accordion-body" id="' + bodyId + '" hidden>' +
        '<pre class="summary-content">' + this._escapeHtml(body) + '</pre>' +
      '</div>' +
    '</div>' +
    '<div class="compaction-divider"></div>';

  const head = block.querySelector('.summary-accordion-head');
  head.addEventListener('click', function() {
    const expanded = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', String(!expanded));
    const bodyEl = document.getElementById(bodyId);
    if (bodyEl) bodyEl.hidden = expanded;
    head.querySelector('.tool-chevron').style.transform = expanded ? '' : 'rotate(90deg)';
  });

  this.container.appendChild(block);
  this.scrollToBottom();
},
```

---

### 7. `frontend/js/app.js` — `loadSession()` 변경

세션 로드 시 메시지를 순회하면서 `is_summary = 1`인 메시지를 `addSummaryBlock()`으로 렌더링한다.
`is_compacted = 1`인 원본 메시지는 **일반 메시지와 동일하게 렌더링**한다 (유저가 전체 히스토리 확인 가능).

```javascript
// app.js — loadSession() 내 messages.forEach 부분

messages.forEach(msg => {
  let content = msg.content;
  try { content = JSON.parse(content); } catch { /* 문자열 그대로 사용 */ }

  // ── 요약 메시지 → 아코디언으로 표시 ──────────────────────
  if (msg.is_summary === 1) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    ChatRenderer.addSummaryBlock(text);
    return; // 아래 일반 렌더링 스킵
  }

  // ── 일반 메시지 (is_compacted 여부 무관하게 동일 렌더링) ──
  if (msg.role === 'user') {
    const text = typeof content === 'string' ? content : (content[0]?.text ?? '');
    ChatRenderer.addUserBlock(text, generateId());

  } else if (msg.role === 'assistant') {
    // ... 기존 assistant 렌더링 코드 유지 ...
  }
});
```

---

## 변경 파일 요약

| 파일 | 변경 내용 |
|------|-----------|
| `server/schema.sql` | `messages` 테이블에 `is_compacted`, `is_summary` 컬럼 추가 |
| `server/db.ts` | 기존 DB 마이그레이션 코드 추가 (ALTER TABLE) |
| `server/compaction.ts` | 쿼리: `is_compacted=0`만 조회 / 트랜잭션: DELETE→UPDATE + is_summary=1 INSERT |
| `server/index.ts` | `loadHistory()`: `is_compacted=0`만 조회 |
| `server/routes/sessions.ts` | `GET /api/sessions/:id`: `is_compacted`, `is_summary` 필드 포함 반환 |
| `frontend/js/chat.js` | `ChatRenderer.addSummaryBlock()` 함수 추가 |
| `frontend/js/app.js` | `loadSession()`: `is_summary=1` 메시지를 `addSummaryBlock()`으로 분기 처리 |

---

## 동작 시나리오

### 첫 번째 컴팩션 발생 후 세션 재오픈

```
UI에 보이는 메시지 순서:
  [user]      "안녕"                      ← is_compacted=1, 일반 렌더링
  [assistant] "안녕하세요"               ← is_compacted=1, 일반 렌더링
  [user]      "BT 스펙 알려줘"            ← is_compacted=1, 일반 렌더링
  [assistant] "BT 5.3 스펙은..."         ← is_compacted=1, 일반 렌더링
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ⚡ 이전 대화 4개 메시지 요약  ▶         ← is_summary=1, 아코디언 (기본 접힘)
     [클릭하면 펼쳐짐]
     사용자가 BT 스펙을 문의함.
     주요 내용: BT 5.3, HCI...
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  [user]      "그럼 WiFi는?"              ← is_compacted=0, 일반 렌더링
  [assistant] "WiFi 6E는..."             ← is_compacted=0, 일반 렌더링
```

### 두 번째 컴팩션 발생

- `loadHistory()` 쿼리가 `is_compacted=0`만 조회하므로, 첫 번째 요약 메시지(`is_summary=1, is_compacted=0`)가 포함된다.
- 두 번째 컴팩션은 첫 번째 요약 텍스트를 포함하여 다시 LLM으로 재요약한다.
- 첫 번째 요약 메시지 row: `is_compacted=1`로 업데이트.
- 두 번째 요약 메시지 row: 신규 INSERT (`is_summary=1, is_compacted=0`).

UI에서는 두 개의 아코디언이 시간순으로 표시된다.

---

## CSS 추가 (필요 시)

기존 `.block--compaction`, `.tool-accordion-head` 스타일을 재활용한다.
추가로 `.summary-accordion-body pre.summary-content`에 padding, font-size 등 스타일 지정.

```css
/* main.css 또는 인라인 — 기존 tool-accordion 스타일과 동일하게 맞춤 */
.summary-accordion-body {
  padding: 8px 12px;
}
.summary-content {
  font-size: 12px;
  white-space: pre-wrap;
  color: var(--text-2);
  margin: 0;
}
```

---

## 주의사항

1. **`loadHistory()` 위치 확인 필요**: `server/index.ts`에서 인라인으로 정의되어 있을 수 있다. 파일 내 `loadHistory` 함수를 찾아서 쿼리를 수정할 것.
2. **실시간 컴팩션 WS 이벤트**: 현재 채팅 중 컴팩션 발생 시 `ChatRenderer.addCompactionBlock()`이 호출된다. 이 흐름은 그대로 유지해도 되고, 실시간에서도 요약 내용을 아코디언으로 보여주려면 서버에서 `compaction` WS 이벤트에 `summaryText` 필드를 추가하고 `addSummaryBlock()`으로 변경하면 된다 (선택 사항).
3. **기존 데이터 호환**: 마이그레이션 후 기존 메시지는 `is_compacted=0, is_summary=0`으로 유지되므로 기존 세션 로드에 영향 없다.
