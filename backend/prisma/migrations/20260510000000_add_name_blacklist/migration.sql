-- v1.1.73: name blacklist for username write rejection.
-- Idempotent (CLAUDE.md "Prisma Migrations MUST Be Idempotent").

CREATE TABLE IF NOT EXISTS "name_blacklist" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "pattern" TEXT NOT NULL,
  "match_type" TEXT NOT NULL DEFAULT 'exact',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_by" TEXT,
  CONSTRAINT "name_blacklist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "name_blacklist_pattern_key" ON "name_blacklist"("pattern");
CREATE INDEX IF NOT EXISTS "name_blacklist_enabled_idx" ON "name_blacklist"("enabled");

-- Seed: common FO76 in-game item / menu strings that have been observed
-- latching onto the username extraction. Idempotent via ON CONFLICT.
INSERT INTO "name_blacklist" ("pattern", "match_type", "note") VALUES
  ('Basic Repair Kit',     'exact',    'FO76 item — observed latched 2026-05-10'),
  ('Improved Repair Kit',  'exact',    'FO76 item'),
  ('Stimpak',              'exact',    'FO76 consumable'),
  ('Diluted Stimpak',      'exact',    'FO76 consumable'),
  ('Super Stimpak',        'exact',    'FO76 consumable'),
  ('RadAway',              'exact',    'FO76 consumable'),
  ('Diluted RadAway',      'exact',    'FO76 consumable'),
  ('Rad-X',                'exact',    'FO76 consumable'),
  ('Power Armor',          'exact',    'FO76 item'),
  ('Fusion Core',          'exact',    'FO76 item'),
  ('Bottle Cap',           'exact',    'FO76 currency'),
  ('Caps',                 'exact',    'FO76 currency'),
  ('Bobblehead',           'contains', 'FO76 collectibles prefix'),
  ('Magazine',             'contains', 'FO76 collectibles'),
  ('Nuka-Cola',            'contains', 'FO76 consumable family'),
  ('Wanderer',             'exact',    'default placeholder; never accept as real name'),
  ('Vault Dweller',        'exact',    'FO76 default'),
  ('Vault-Tec',            'contains', 'menu / brand string'),
  ('Plan:',                'contains', 'FO76 plan/recipe prefix'),
  ('Recipe:',              'contains', 'FO76 recipe prefix'),
  ('SCORE',                'exact',    'menu label'),
  ('S.P.E.C.I.A.L.',       'contains', 'menu label'),
  ('Atomic Shop',          'contains', 'menu label'),
  ('Fallout 76',           'contains', 'menu / banner string'),
  ('Settings',             'exact',    'menu label'),
  ('Main Menu',            'exact',    'menu label')
ON CONFLICT ("pattern") DO NOTHING;
