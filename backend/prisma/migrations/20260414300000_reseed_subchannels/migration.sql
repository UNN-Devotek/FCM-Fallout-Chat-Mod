-- Fresh seed migration — previous one kept failing due to failed-migration state tracking.
-- Fully idempotent: inserts Trading/Events/Raids under General.
INSERT INTO channels (id, name, color, parent_id, sort_order, created_at, updated_at)
VALUES
    ('00000000-0000-0000-0000-000000000002', 'Trading', '#18FF62', '00000000-0000-0000-0000-000000000001', 10, NOW(), NOW()),
    ('00000000-0000-0000-0000-000000000003', 'Events',  '#18FF62', '00000000-0000-0000-0000-000000000001', 20, NOW(), NOW()),
    ('00000000-0000-0000-0000-000000000004', 'Raids',   '#18FF62', '00000000-0000-0000-0000-000000000001', 30, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
    parent_id = EXCLUDED.parent_id,
    sort_order = EXCLUDED.sort_order;
