# TASKS — IntelliSearch
> 구현 태스크 목록 | 작성: 2026-02-28
> Claude Code에서 이 파일을 보며 순서대로 구현한다.
> 완료 시 [ ] → [x] 로 변경.

---

## 🏗 Phase 0 — 프로젝트 스캐폴딩
> 목표: 실행 가능한 뼈대 완성. 브라우저에서 WebSocket 연결 후 에코 확인.

- [ ] **T-001** 디렉토리 구조 생성
  ```
  intellisearch/
  ├── frontend/  (html, css/, js/)
  ├── server/    (Node.js + TypeScript)
  └── api/       (Python Flask)
  ```

- [ ] **T-002** `server/package.json` 설정
  ```json
  {
    "dependencies": {
      "@mariozechner/pi-ai": "latest",
      "@mariozechner/pi-agent-core": "latest",
      "ws": "^8",
      "dotenv": "^16"
    },
    "devDependencies": {
      "tsx": "^4",
      "typescript": "^5",
      "@types/ws": "^8",
      "@types/node": "^20"
    }
  }
  ```

- [ ] **T-003** `server/tsconfig.json` 설정 (NodeNext module, strict)

- [ ] **T-004** `api/requirements.txt` 작성
  ```
  flask>=3.0
  flask-cors
  requests
  pymupdf        # PDF 텍스트 추출
  python-pptx
  python-docx
  numpy
  python-dotenv
  ```

- [ ] **T-005** `.env.example` 파일 생성 (TRD §10 참조)

- [ ] **T-006** `server/index.ts` — WebSocket 서버 뼈대
  - ws 라이브러리로 서버 열기 (포트 3000)
  - 연결/해제 로그
  - 메시지 에코 (테스트용)

- [ ] **T-007** `api/app.py` — Flask 뼈대
  - CORS 설정
  - `/health` GET 엔드포인트
  - 환경 변수 로드

- [ ] **T-008** `frontend/index.html` — 목업에서 분리
  - `docs/mockup.html` → `frontend/index.html` 복사
  - CSS를 `frontend/css/main.css`로 분리
  - JS를 `frontend/js/app.js`로 분리
  - WebSocket 연결 코드 추가 (ws://localhost:3000)

---

## 🔌 Phase 1 — 기본 채팅 (Agent loop 없이)
> 목표: 브라우저 → Node.js → vLLM 스트리밍 응답 확인

- [ ] **T-010** `server/models.ts` — vLLM 모델 3개 정의 (CLAUDE.md 코드 참조)

- [ ] **T-011** `server/index.ts` — chat 메시지 처리
  - WebSocket에서 `{ type: "chat" }` 수신
  - pi-ai `streamSimple()` 직접 호출 (tool 없이)
  - token 이벤트 → WS로 스트리밍

- [ ] **T-012** `frontend/js/app.js` — WebSocket 클라이언트
  - WS 연결 및 재연결 로직
  - `{ type: "token" }` 수신 → 채팅창에 append
  - `{ type: "agent_end" }` 수신 → 입력창 활성화

- [ ] **T-013** `frontend/js/chat.js` — 메시지 렌더링
  - 사용자 메시지 말풍선
  - AI 응답 말풍선 (스트리밍 중 커서 표시)
  - 마크다운 렌더링 (코드블록 하이라이트)

- [ ] **T-014** Stop 버튼 연동
  - 브라우저: `{ type: "stop" }` 전송
  - Node.js: `AbortController.abort()` 호출
  - 스트리밍 즉시 중단

**✅ Phase 1 완료 기준**: 브라우저에서 질문 입력 → 스트리밍 응답 확인, Stop 동작 확인

---

## 🗃 Phase 2 — 세션 관리
> 목표: 대화 이력 저장, 사이드바 세션 목록

- [ ] **T-020** `api/db/schema.sql` — SQLite 스키마 생성 (TRD §5 전체)

- [ ] **T-021** `api/db/database.py` — SQLite 연결 헬퍼
  - `get_db()` 함수
  - 초기화 시 schema.sql 실행

- [ ] **T-022** `api/routes/sessions.py` — 세션 CRUD
  - `GET /api/sessions` — 목록 (최근 순)
  - `POST /api/sessions` — 새 세션 생성 (id, title, created_at)
  - `GET /api/sessions/:id` — 메시지 이력 포함
  - `DELETE /api/sessions/:id`

- [ ] **T-023** `server/index.ts` — 세션 연동
  - chat 수신 시 sessionId로 기존 이력 로드
  - 메시지 저장 (Flask POST /api/sessions/:id/messages)
  - `sessions.list` / `sessions.delete` 처리

- [ ] **T-024** `frontend/js/app.js` — 사이드바 세션 목록
  - 앱 시작 시 세션 목록 로드
  - 세션 클릭 → 이전 대화 복원
  - 새 채팅 버튼 → 세션 생성
  - 세션 삭제 (우클릭 메뉴 또는 x 버튼)

- [ ] **T-025** 세션 타이틀 자동 생성
  - 첫 메시지 후 LLM으로 5단어 내 타이틀 생성
  - `PATCH /api/sessions/:id` 로 업데이트

**✅ Phase 2 완료 기준**: 새로고침 후에도 대화 이력 유지, 사이드바에 세션 목록 표시

---

## 🤖 Phase 3 — Agent Loop (pi-agent-core)
> 목표: tool call 실행, 상태 표시, 컴팩션

- [ ] **T-030** `server/agent.ts` — Agent 클래스 래퍼
  - `createAgent(sessionId, config)` 함수
  - pi-agent-core `Agent` 인스턴스 생성
  - onEvent 핸들러 → WS 이벤트 변환

- [ ] **T-031** WS 이벤트 매핑
  ```
  agent_start          → (무시 또는 로딩 표시)
  message_update       → token 이벤트
  tool_execution_start → tool_start 이벤트
  tool_execution_end   → tool_end 이벤트
  agent_end            → agent_end 이벤트
  compaction           → compaction 이벤트
  ```

- [ ] **T-032** `frontend/js/chat.js` — tool call 카드 렌더링
  - tool_start: 카드 생성 (tool 이름, 파라미터 요약, 로딩 스피너)
  - tool_end: 스피너 → 완료 표시, details 렌더링 (출처, 이슈 수 등)
  - 카드 토글 (펼치기/접기)

- [ ] **T-033** 컴팩션 알림 UI
  - compaction 이벤트 수신 시 채팅 중간에 알림 표시
  - "대화가 길어져 이전 내용을 요약했습니다"

**✅ Phase 3 완료 기준**: tool call 카드가 순서대로 표시되며, 컴팩션 알림 동작

---

## 🔍 Phase 4 — RAG 연동
> 목표: 실제 RAG 검색 tool 동작

- [ ] **T-040** `api/routes/rag.py` — RAG 검색 API
  - `POST /api/rag/search` → 사내 RAGaaS 호출
  - `GET /api/rag/indexes` → 인덱스 목록 반환

- [ ] **T-041** `server/tools/rag.ts` — rag_search AgentTool
  - parameters: `{ query, indexes }` (TypeBox)
  - execute: Flask `/api/rag/search` 호출
  - details: 검색 결과 출처 목록 (UI 카드용)

- [ ] **T-042** 인덱스 바 연동
  - 앱 시작 시 `GET /api/rag/indexes` → 인덱스 바 렌더링
  - 페르소나 선택 → 관련 인덱스 자동 활성화
  - 수동 토글 → `config.indexes` 업데이트

- [ ] **T-043** RAG 결과 출처 카드
  - tool_end details에서 sources 추출
  - 문서명, 청크, 유사도 점수 표시

**✅ Phase 4 완료 기준**: "BT-4821 분석해줘" → RAG + Jira tool 호출 후 답변 확인

---

## ⟵⟶ Phase 5 — 번역 모드
> 목표: tool 없이 LLM 직통 번역, UI 전환

- [ ] **T-050** `server/translate.ts` — 번역 직통 함수 (TRD §3.2 참조)

- [ ] **T-051** `server/index.ts` — `{ type: "translate" }` 처리
  - `translateDirect()` 호출
  - translate 전용 token/agent_end 이벤트 전송

- [ ] **T-052** `api/routes/sessions.py` — 번역 설정 저장/로드
  - `GET /api/settings` → user_settings 조회
  - `PUT /api/settings` → 번역 기본 설정 저장

- [ ] **T-053** `frontend/js/app.js` — 번역 모드 UI 연동
  - 번역 토글 버튼 → WS config에 mode: "translate" 반영
  - 타겟 언어 선택 → config.targetLang 업데이트
  - FAST 모델 전환 제안 토스트 (mockup 동작 그대로)

- [ ] **T-054** 번역 결과 말풍선 스타일
  - 보라색 테두리 카드
  - 상단에 "⟵⟶ [EN → KO]" 메타 표시

**✅ Phase 5 완료 기준**: 번역 모드 ON → 영어 텍스트 입력 → tool 카드 없이 즉시 한국어 응답

---

## 🔌 Phase 6 — MCP 연동
> 목표: Gerrit/Jira MCP 서버 등록 및 tool 자동 등록

- [ ] **T-060** `api/routes/mcp.py` — MCP 서버 CRUD + 연결 테스트

- [ ] **T-061** `server/tools/mcp.ts` — MCP tool 동적 로드 (TRD §6 참조)
  - 세션 시작 시 활성 MCP 서버 목록 조회
  - 각 서버에 tools/list 요청
  - AgentTool로 래핑 후 Agent에 등록

- [ ] **T-062** 설정 패널 → MCP 서버 관리 UI 연동
  - 목록 로드, 추가, 삭제, 연결 테스트 API 호출

**✅ Phase 6 완료 기준**: Gerrit MCP에서 CR 번호로 diff 조회 성공

---

## ⚙️ Phase 7 — Skill 시스템
> 목표: SKILL.md 기반 워크플로우 실행

- [ ] **T-070** `api/routes/skills.py` — Skill CRUD

- [ ] **T-071** `server/tools/skill.ts` — Skill AgentTool
  - Agent가 대화 중 Skill 실행 트리거 감지
  - SKILL.md를 system prompt에 주입해 실행

- [ ] **T-072** 설정 패널 Skill 관리 UI 연동

- [ ] **T-073** Cron Job 등록 (`api/routes/skills.py`)
  - APScheduler로 스케줄 등록
  - 실행 결과 → 새 세션 생성 후 전달

**✅ Phase 7 완료 기준**: "주간 BT 이슈 요약" Skill 수동 실행 성공

---

## 📎 Phase 8 — 파일 업로드 (임시 RAG)
> 목표: PDF/docx 첨부 → 세션 내 검색 가능

- [ ] **T-080** `api/routes/sessions.py` — 파일 업로드 엔드포인트
  - `POST /api/sessions/:id/upload`
  - pymupdf/python-docx 텍스트 추출
  - 토큰 수 측정 → 8K 기준 분기
  - 대용량: 청크 분할 → 사내 임베딩 → 메모리 저장

- [ ] **T-081** `server/tools/rag.ts` — search_document tool 추가
  - 파일 업로드 완료 시 동적으로 Agent에 추가

- [ ] **T-082** 첨부 버튼 UI 연동
  - 파일 선택 → multipart POST 업로드
  - 완료 시 채팅창에 첨부 파일 카드 표시

**✅ Phase 8 완료 기준**: PDF 첨부 후 "이 문서에서 ~~ 찾아줘" 질문 → 내용 기반 응답

---

## ⚙️ Phase 9 — 설정 패널 완전 연동

- [ ] **T-090** `api/routes/settings.py` — 설정 CRUD
  - `GET/PUT /api/settings` — user_settings 테이블

- [ ] **T-091** `frontend/js/settings.js` 분리
  - 설정 패널 열기/닫기
  - 각 섹션 저장 → API 호출

- [ ] **T-092** Agent.md 설정 저장/로드 → 시스템 프롬프트에 반영

- [ ] **T-093** LLM 파라미터 설정 → Node.js Agent config에 반영

---

## 🗺 Phase 10 — RCA Map (Jira 구조화 지식베이스)
> 나중에 구현. 우선순위 P2.

- [ ] **T-100** Jira 이슈 배치 처리 스크립트 (`api/batch_rca.py`)
- [ ] **T-101** AI 구조화 문서 스키마 설계 및 저장
- [ ] **T-102** RCA 검색 tool 추가
- [ ] **T-103** 신규 이슈 자동 업데이트 Cron

---

## 📋 태스크 현황 요약

| Phase | 내용 | 태스크 수 | 상태 |
|-------|------|-----------|------|
| 0 | 스캐폴딩 | 8 | ⬜ 대기 |
| 1 | 기본 채팅 | 5 | ⬜ 대기 |
| 2 | 세션 관리 | 6 | ⬜ 대기 |
| 3 | Agent Loop | 4 | ⬜ 대기 |
| 4 | RAG 연동 | 4 | ⬜ 대기 |
| 5 | 번역 모드 | 5 | ⬜ 대기 |
| 6 | MCP 연동 | 3 | ⬜ 대기 |
| 7 | Skill 시스템 | 4 | ⬜ 대기 |
| 8 | 파일 업로드 | 3 | ⬜ 대기 |
| 9 | 설정 패널 | 4 | ⬜ 대기 |
| 10 | RCA Map | 4 | ⬜ 대기 |

**총 50개 태스크** — Phase 0~5가 핵심 MVP (31개)

---

## Claude Code 사용 팁

```bash
# Claude Code 시작 시 이렇게 말하면 됨:
"CLAUDE.md, PRD.md, TRD.md, TASKS.md 읽고
TASKS.md의 Phase 0부터 순서대로 구현해줘.
각 태스크 완료 시 TASKS.md에서 [ ] → [x] 표시해줘."

# 특정 Phase만 시킬 때:
"Phase 5 번역 모드 구현해줘. TRD §3.2 참고."

# 막혔을 때:
"docs/pi-agent-core-spec.md 읽고 tool 등록 방법 확인해줘."
```
