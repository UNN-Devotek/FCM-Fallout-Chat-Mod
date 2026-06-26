-- hud_link_codes: short device-authorization codes (8-char Crockford base32)
-- Issued by the relay (per relay_user_id); redeemed by an authed FCM user on /link.
-- One active code per relay identity; a new request supersedes the old.
-- relay_user_id: the limited relay identity (chat.v1 userId) the code is bound to (relay owns this).
-- redeemed_by_user_id: the authed FCM account that completed the link (set on successful redeem).
CREATE TABLE IF NOT EXISTS hud_link_codes (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  TEXT        NOT NULL,
  relay_user_id         TEXT        NOT NULL,
  redeemed_by_user_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  attempts              INT         NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS hud_link_codes_code_idx ON hud_link_codes (code);
CREATE INDEX IF NOT EXISTS hud_link_codes_relay_user_id_idx ON hud_link_codes (relay_user_id);
CREATE INDEX IF NOT EXISTS hud_link_codes_expires_at_idx ON hud_link_codes (expires_at);
