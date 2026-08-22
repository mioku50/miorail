-- Idempotent: 0000 was regenerated after this migration was written and now
-- creates "actions" with this column already present, so a replay from an
-- empty database hit 42701. Deployed databases baselined past 0008 and never
-- run this file; drizzle skips by created_at and never compares the hash.
ALTER TABLE "actions" ADD COLUMN IF NOT EXISTS "execution_payload" jsonb;