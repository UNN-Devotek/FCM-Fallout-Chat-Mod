-- Add image_key, source_type, source_label to camp_items (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'camp_items' AND column_name = 'image_key'
  ) THEN
    ALTER TABLE camp_items ADD COLUMN image_key text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'camp_items' AND column_name = 'source_type'
  ) THEN
    ALTER TABLE camp_items ADD COLUMN source_type text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'camp_items' AND column_name = 'source_label'
  ) THEN
    ALTER TABLE camp_items ADD COLUMN source_label text;
  END IF;
END $$;
