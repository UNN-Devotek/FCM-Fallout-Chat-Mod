-- =============================================================================
-- Fallout Chat Mod — Database Schema
-- PostgreSQL 16 + TimescaleDB
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- =============================================================================
-- Users
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        TEXT NOT NULL,
    steam_id        TEXT,
    install_token   TEXT UNIQUE NOT NULL,
    discord_id_link TEXT UNIQUE,
    discord_username TEXT,
    discord_avatar  TEXT,
    is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
    is_muted        BOOLEAN NOT NULL DEFAULT FALSE,
    mute_expires_at TIMESTAMPTZ,
    ban_reason      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_install_token    ON users (install_token);
CREATE INDEX IF NOT EXISTS idx_users_steam_id         ON users (steam_id);
CREATE INDEX IF NOT EXISTS idx_users_is_banned        ON users (is_banned);
CREATE INDEX IF NOT EXISTS idx_users_username         ON users (username);

-- =============================================================================
-- Sessions (also tracked in Redis; DB copy for audit)
-- =============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    token       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- =============================================================================
-- Channels
-- =============================================================================
CREATE TABLE IF NOT EXISTS channels (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               TEXT NOT NULL,
    color              TEXT NOT NULL DEFAULT '#18FF62',   -- Phosphor green default
    parent_id          UUID REFERENCES channels (id) ON DELETE SET NULL,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    discord_relay      BOOLEAN NOT NULL DEFAULT FALSE,
    discord_channel_id TEXT,
    is_archived        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS channels_parent_id_idx ON channels (parent_id);

-- Seed default channels
INSERT INTO channels (id, name, color)
VALUES ('00000000-0000-0000-0000-000000000001', 'General', '#18FF62')
ON CONFLICT (id) DO NOTHING;

INSERT INTO channels (id, name, color, parent_id, sort_order)
VALUES
  ('00000000-0000-0000-0000-000000000002', 'Trading', '#18FF62', '00000000-0000-0000-0000-000000000001', 10),
  ('00000000-0000-0000-0000-000000000003', 'Events',  '#18FF62', '00000000-0000-0000-0000-000000000001', 20),
  ('00000000-0000-0000-0000-000000000004', 'Raids',   '#18FF62', '00000000-0000-0000-0000-000000000001', 30)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- Messages (TimescaleDB hypertable — partitioned by time)
-- =============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id          UUID            NOT NULL DEFAULT gen_random_uuid(),
    content     TEXT            NOT NULL,
    user_id     UUID            NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    channel_id  UUID            NOT NULL REFERENCES channels (id) ON DELETE RESTRICT,
    source      TEXT            NOT NULL DEFAULT 'game' CHECK (source IN ('game', 'discord')),
    is_deleted  BOOLEAN         NOT NULL DEFAULT FALSE,
    edited_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
);

-- Convert to hypertable (partitioned weekly)
SELECT create_hypertable(
    'messages', 'created_at',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- 90-day data retention policy
SELECT add_retention_policy(
    'messages',
    INTERVAL '90 days',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_id    ON messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_is_deleted ON messages (is_deleted) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_messages_id         ON messages (id);  -- point lookups by message ID (e.g. report context)

-- =============================================================================
-- Discord Relay Message Links
-- =============================================================================
CREATE TABLE IF NOT EXISTS discord_message_links (
    id                   SERIAL PRIMARY KEY,
    message_id           UUID NOT NULL,
    discord_message_id   TEXT NOT NULL,
    discord_channel_id   TEXT NOT NULL,
    discord_prefix       TEXT NOT NULL,
    is_bot_message       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    UNIQUE (message_id),
    UNIQUE (discord_message_id, discord_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_message_links_discord_message_id
    ON discord_message_links (discord_message_id);

-- =============================================================================
-- Reports
-- =============================================================================
CREATE TYPE report_status AS ENUM ('open', 'resolved', 'dismissed', 'escalated');

CREATE TABLE IF NOT EXISTS reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    target_user_id   UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id       UUID,           -- may be NULL if reporting a user generally
    reason           TEXT NOT NULL,
    notes            TEXT,
    status           report_status NOT NULL DEFAULT 'open',
    resolved_by      UUID REFERENCES users (id),
    resolved_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_status          ON reports (status);
CREATE INDEX IF NOT EXISTS idx_reports_target_user_id  ON reports (target_user_id);

-- =============================================================================
-- Audit Log (TimescaleDB hypertable)
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    actor_id   UUID        REFERENCES users (id) ON DELETE SET NULL,
    action     TEXT        NOT NULL,
    target_id  UUID,
    target_type TEXT,
    reason     TEXT,
    metadata   JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
);

SELECT create_hypertable(
    'audit_logs', 'created_at',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- 90-day retention for audit logs
SELECT add_retention_policy(
    'audit_logs',
    INTERVAL '90 days',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id  ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON audit_logs (action, created_at DESC);

-- =============================================================================
-- Word Filter Configuration
-- =============================================================================
CREATE TABLE IF NOT EXISTS word_filter (
    id         SERIAL PRIMARY KEY,
    phrase     TEXT NOT NULL UNIQUE,
    is_regex   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Discord Relay Channel Mappings
-- =============================================================================
CREATE TABLE IF NOT EXISTS discord_relay_mappings (
    id                  SERIAL PRIMARY KEY,
    in_game_channel_id  UUID NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    discord_channel_id  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (in_game_channel_id, discord_channel_id)
);

-- =============================================================================
-- Helper: updated_at trigger
-- =============================================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_channels_updated_at
    BEFORE UPDATE ON channels
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- Moderation Settings
-- =============================================================================
CREATE TABLE IF NOT EXISTS moderation_settings (
    id SERIAL PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

INSERT INTO moderation_settings (key, value, updated_at) VALUES
  ('spam_message_limit', '6', NOW()),
  ('spam_window_ms', '10000', NOW())
ON CONFLICT (key) DO NOTHING;
