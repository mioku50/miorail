-- Idempotent for the same reason as 0001: 0000 already creates this column.
ALTER TABLE "actions" ADD COLUMN IF NOT EXISTS "metadata" jsonb;