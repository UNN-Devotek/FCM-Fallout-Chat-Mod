-- Give each seeded sub-channel a distinct badge color.
-- Uses ON CONFLICT so this is safe to re-run.
UPDATE channels SET color = '#4A9FE0' WHERE id = '00000000-0000-0000-0000-000000000002' AND (color = '' OR color = '#18FF62');
UPDATE channels SET color = '#50C878' WHERE id = '00000000-0000-0000-0000-000000000003' AND (color = '' OR color = '#18FF62');
UPDATE channels SET color = '#FF6644' WHERE id = '00000000-0000-0000-0000-000000000004' AND (color = '' OR color = '#18FF62');
