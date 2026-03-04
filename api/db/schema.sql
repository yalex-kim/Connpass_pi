-- Connpass SQLite Schema
-- TRD §5 전체 스키마

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 세션 테이블
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL DEFAULT 'default',
    title       TEXT NOT NULL DEFAULT '새 대화',
    persona     TEXT,
    model       TEXT NOT NULL DEFAULT 'GLM4.7',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- 메시지 테이블
CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- MCP 서버 테이블
CREATE TABLE IF NOT EXISTS mcp_servers (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL DEFAULT 'default',
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    transport   TEXT NOT NULL DEFAULT 'streamable-http',  -- 'streamable-http' | 'sse'
    headers     TEXT,           -- JSON 문자열
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);


-- 사용량 로그 테이블
CREATE TABLE IF NOT EXISTS usage_logs (
    id              TEXT PRIMARY KEY,
    session_id      TEXT,
    user_id         TEXT NOT NULL DEFAULT 'default',
    model           TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'chat',  -- 'chat' | 'translate' | 'skill'
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

-- 사용자 설정 테이블
CREATE TABLE IF NOT EXISTS user_settings (
    user_id             TEXT PRIMARY KEY DEFAULT 'default',
    agent_md            TEXT,           -- Agent 시스템 프롬프트 (AGENT.md 내용)
    default_model       TEXT NOT NULL DEFAULT 'GLM4.7',
    translate_model     TEXT NOT NULL DEFAULT 'GLM4.7',
    translate_lang      TEXT NOT NULL DEFAULT 'ko',
    translate_prompt    TEXT,
    ui_settings         TEXT            -- JSON (테마, 폰트 크기 등)
);

-- 기본 사용자 설정 삽입 (없으면)
INSERT OR IGNORE INTO user_settings (user_id, default_model, translate_model, translate_lang)
VALUES ('default', 'GLM4.7', 'GLM4.7', 'ko');

-- Jira 서버 테이블
CREATE TABLE IF NOT EXISTS jira_servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    email       TEXT DEFAULT '',
    token       TEXT DEFAULT '',
    prefixes    TEXT DEFAULT '',   -- 쉼표 구분 프로젝트 prefix (예: "BT,BT-TEST,WLAN")
    enabled     INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- Gerrit 서버 테이블
CREATE TABLE IF NOT EXISTS gerrit_servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    username    TEXT DEFAULT '',   -- HTTP Basic Auth 사용자명
    token       TEXT DEFAULT '',   -- HTTP 패스워드 또는 Bearer Token
    auth_type   TEXT DEFAULT 'basic',  -- 'basic' | 'bearer'
    enabled     INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- LLM 모델별 서버/파라미터 설정 테이블
CREATE TABLE IF NOT EXISTS llm_model_configs (
    model_id        TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL DEFAULT '',   -- UI 표시 이름
    base_url        TEXT NOT NULL DEFAULT 'http://vllm.internal/v1',
    api_key         TEXT DEFAULT '',
    temperature     REAL DEFAULT 0.7,
    max_tokens      INTEGER DEFAULT 4096,
    context_window  INTEGER DEFAULT 128000,
    is_builtin      INTEGER DEFAULT 0,          -- 1: 기본 제공, 0: 사용자 추가
    user_id         TEXT NOT NULL DEFAULT 'default'
);

-- 기본 모델 설정 삽입
INSERT OR IGNORE INTO llm_model_configs (model_id, display_name, base_url, temperature, max_tokens, context_window, is_builtin, user_id)
VALUES
    ('GLM4.7',       'GLM4.7',       'http://vllm.internal/v1', 0.7, 8192,  128000, 1, 'default'),
    ('Kimi-K2.5',    'Kimi-K2.5',    'http://vllm.internal/v1', 0.7, 4096,  32000,  1, 'default'),
    ('GPT-OSS-120B', 'GPT-OSS-120B', 'http://vllm.internal/v1', 0.7, 8192,  128000, 1, 'default');

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_gerrit_servers_enabled ON gerrit_servers(enabled);
CREATE INDEX IF NOT EXISTS idx_jira_servers_enabled ON jira_servers(enabled);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_id ON mcp_servers(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_model_configs_user_id ON llm_model_configs(user_id);
