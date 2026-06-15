-- Seed default sub-channels under General for existing databases
INSERT INTO channels (id, name, color, parent_id, sort_order, updated_at)
VALUES
    ('00000000-0000-0000-0000-000000000002', 'Trading', '#18FF62', '00000000-0000-0000-0000-000000000001', 10, NOW()),
    ('00000000-0000-0000-0000-000000000003', 'Events',  '#18FF62', '00000000-0000-0000-0000-000000000001', 20, NOW()),
    ('00000000-0000-0000-0000-000000000004', 'Raids',   '#18FF62', '00000000-0000-0000-0000-000000000001', 30, NOW())
ON CONFLICT (id) DO NOTHING;
