-- GitHub issue <-> Discord thread mapping for the Discord ticketing feature.
-- Idempotent (IF NOT EXISTS) so it is safe under baseline-migrations.sh, which
-- runs `db push` before `migrate deploy`. See docs/database/migrations.md.

CREATE TABLE IF NOT EXISTS github_issue_threads (
  id                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  issue_number       INTEGER     NOT NULL,
  issue_node_id      TEXT        NOT NULL,
  issue_url          TEXT        NOT NULL,
  type               TEXT        NOT NULL,
  discord_thread_id  TEXT        NOT NULL,
  discord_channel_id TEXT        NOT NULL,
  reporter_id        TEXT        NOT NULL,
  is_private         BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT github_issue_threads_pkey PRIMARY KEY (id),
  CONSTRAINT github_issue_threads_issue_number_key UNIQUE (issue_number),
  CONSTRAINT github_issue_threads_discord_thread_id_key UNIQUE (discord_thread_id)
);

CREATE INDEX IF NOT EXISTS github_issue_threads_discord_thread_id_idx
  ON github_issue_threads (discord_thread_id);
