-- Add allowed_channel_id to chat_commands (restricts which channel a command may be triggered from)
ALTER TABLE chat_commands ADD COLUMN IF NOT EXISTS allowed_channel_id UUID;

-- Seed Fallout 76 event announcement commands.
-- target_channel_id = Events channel (00000000-0000-0000-0000-000000000003)
-- allowed_channel_id = NULL (unrestricted by default; configurable per-command in admin dashboard)
-- cooldown_sec = 30 to prevent repeat-spam
-- ON CONFLICT (trigger) DO NOTHING — idempotent re-runs

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/acp',  'Announce A Colossal Problem (Earle)',         'A Colossal Problem event on this server, player count [Server Count]/24.',        'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/bob',  'Announce Beasts of Burden',                   'Beasts of Burden event on this server, player count [Server Count]/24.',           'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/ct',   'Announce Campfire Tales',                     'Campfire Tales event on this server, player count [Server Count]/24.',              'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/dc',   'Announce Dropped Connections',                'Dropped Connections event on this server, player count [Server Count]/24.',         'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/dg',   'Announce Distinguished Guests',               'Distinguished Guests event on this server, player count [Server Count]/24.',        'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/dpt',  'Announce Dangerous Pastimes',                 'Dangerous Pastimes event on this server, player count [Server Count]/24.',          'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/en',   'Announce Eviction Notice',                    'Eviction Notice event on this server, player count [Server Count]/24.',             'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/enc',  'Announce Encryptid',                          'Encryptid event on this server, player count [Server Count]/24.',                   'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/fr',   'Announce Free Range',                         'Free Range event on this server, player count [Server Count]/24.',                  'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/ftp',  'Announce Feed the People',                    'Feed the People event on this server, player count [Server Count]/24.',             'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/gm',   'Announce Guided Meditation',                  'Guided Meditation event on this server, player count [Server Count]/24.',           'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/hots', 'Announce Heart of the Swamp (Strangler Heart)','Heart of the Swamp event on this server, player count [Server Count]/24.',        'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/jb',   'Announce Jailbreak',                          'Jailbreak event on this server, player count [Server Count]/24.',                   'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/lb',   'Announce Lode Baring',                        'Lode Baring event on this server, player count [Server Count]/24.',                 'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/lits', 'Announce Line in the Sand',                   'Line in the Sand event on this server, player count [Server Count]/24.',            'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/mj',   'Announce Moonshine Jamboree',                 'Moonshine Jamboree event on this server, player count [Server Count]/24.',          'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/mw',   'Announce Most Wanted',                        'Most Wanted event on this server, player count [Server Count]/24.',                 'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/nw',   'Announce Neurological Warfare (nuke event)',  'Neurological Warfare event on this server, player count [Server Count]/24.',        'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/ovn',  'Announce One Violent Night',                  'One Violent Night event on this server, player count [Server Count]/24.',           'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/pp',   'Announce Project Paradise',                   'Project Paradise event on this server, player count [Server Count]/24.',            'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/pte',  'Announce The Path to Enlightenment',          'The Path to Enlightenment event on this server, player count [Server Count]/24.',  'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/rr',   'Announce Radiation Rumble',                   'Radiation Rumble event on this server, player count [Server Count]/24.',            'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/rs',   'Announce Riding Shotgun',                     'Riding Shotgun event on this server, player count [Server Count]/24.',              'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/sa',   'Announce Seismic Activity (nuke event)',       'Seismic Activity event on this server, player count [Server Count]/24.',           'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/sas',  'Announce Safe and Sound',                     'Safe and Sound event on this server, player count [Server Count]/24.',              'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/sbq',  'Announce Scorched Earth (Scorched Beast Queen)','Scorched Earth event on this server, player count [Server Count]/24.',            'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/sos',  'Announce Surface to Air',                     'Surface to Air event on this server, player count [Server Count]/24.',              'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/tol',  'Announce Tunnel of Love',                     'Tunnel of Love event on this server, player count [Server Count]/24.',              'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/tt',   'Announce Tea Time',                           'Tea Time event on this server, player count [Server Count]/24.',                    'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/tym',  'Announce Test Your Metal',                    'Test Your Metal event on this server, player count [Server Count]/24.',             'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;

INSERT INTO chat_commands (trigger, description, response, action_type, target_channel_id, allowed_channel_id, cooldown_sec, enabled, requires_args, created_at, updated_at)
VALUES ('/uf',   'Announce Uranium Fever',                      'Uranium Fever event on this server, player count [Server Count]/24.',               'announce', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 30, true, false, NOW(), NOW())
ON CONFLICT (trigger) DO NOTHING;
