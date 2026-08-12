-- Allocate append-only Action Receipt event sequences on the receipt row.
-- A concurrent UPDATE of the same receipt row is serialized by PostgreSQL;
-- the following event INSERT consumes the allocated value in one statement.

ALTER TABLE "base_mcp_action_receipts"
	ADD COLUMN "next_event_sequence" integer;
--> statement-breakpoint

UPDATE "base_mcp_action_receipts" AS receipt
SET "next_event_sequence" = COALESCE((
	SELECT MAX(event."sequence") + 1
	FROM "base_mcp_action_receipt_events" AS event
	WHERE event."receipt_id" = receipt."id"
), 0);
--> statement-breakpoint

ALTER TABLE "base_mcp_action_receipts"
	ALTER COLUMN "next_event_sequence" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
	ALTER COLUMN "next_event_sequence" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
	ADD CONSTRAINT "base_mcp_action_receipts_next_event_sequence_check"
	CHECK ("next_event_sequence" >= 0);

