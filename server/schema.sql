-- Connpass SQLite Schema

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL DEFAULT 'default',
    title       TEXT NOT NULL DEFAULT '새 대화',
    persona     TEXT,
    model       TEXT NOT NULL DEFAULT 'GLM4.7',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL DEFAULT 'default',
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    transport   TEXT NOT NULL DEFAULT 'streamable-http',
    headers     TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id              TEXT PRIMARY KEY,
    session_id      TEXT,
    user_id         TEXT NOT NULL DEFAULT 'default',
    model           TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'chat',
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id             TEXT PRIMARY KEY DEFAULT 'default',
    agent_md            TEXT,
    default_model       TEXT NOT NULL DEFAULT 'GLM4.7',
    translate_model     TEXT NOT NULL DEFAULT 'GLM4.7',
    translate_lang      TEXT NOT NULL DEFAULT 'ko',
    translate_prompt    TEXT,
    ui_settings         TEXT
);

INSERT OR IGNORE INTO user_settings (user_id, default_model, translate_model, translate_lang)
VALUES ('default', 'GLM4.7', 'GLM4.7', 'ko');

CREATE TABLE IF NOT EXISTS jira_servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    email       TEXT DEFAULT '',
    token       TEXT DEFAULT '',
    prefixes    TEXT DEFAULT '',
    enabled     INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gerrit_servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    username    TEXT DEFAULT '',
    token       TEXT DEFAULT '',
    auth_type   TEXT DEFAULT 'basic',
    enabled     INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_model_configs (
    model_id        TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL DEFAULT '',
    base_url        TEXT NOT NULL DEFAULT 'http://vllm.internal/v1',
    api_key         TEXT DEFAULT '',
    temperature     REAL DEFAULT 0.7,
    max_tokens      INTEGER DEFAULT 4096,
    context_window  INTEGER DEFAULT 128000,
    is_builtin      INTEGER DEFAULT 0,
    user_id         TEXT NOT NULL DEFAULT 'default'
);

INSERT OR IGNORE INTO llm_model_configs (model_id, display_name, base_url, temperature, max_tokens, context_window, is_builtin, user_id)
VALUES
    ('GLM4.7',       'GLM4.7',       'http://vllm.internal/v1', 0.7, 8192,  128000, 1, 'default'),
    ('Kimi-K2.5',    'Kimi-K2.5',    'http://vllm.internal/v1', 0.7, 4096,  32000,  1, 'default'),
    ('GPT-OSS-120B', 'GPT-OSS-120B', 'http://vllm.internal/v1', 0.7, 8192,  128000, 1, 'default');

CREATE TABLE IF NOT EXISTS tool_calls (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    tool_name   TEXT NOT NULL,
    tool_label  TEXT,
    args        TEXT,
    result      TEXT,
    is_error    INTEGER DEFAULT 0,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    order_idx   INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_id ON mcp_servers(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_llm_model_configs_user_id ON llm_model_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_jira_servers_enabled ON jira_servers(enabled);
CREATE INDEX IF NOT EXISTS idx_gerrit_servers_enabled ON gerrit_servers(enabled);
