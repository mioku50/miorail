ALTER TABLE "spend_permissions"
  ALTER COLUMN "limit" TYPE numeric(18, 6) USING "limit"::numeric,
  ALTER COLUMN "spent" TYPE numeric(18, 6) USING "spent"::numeric,
  ALTER COLUMN "spent" SET DEFAULT 0;
