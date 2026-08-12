-- Durable receipts for direct Base MCP extension actions.
--
-- These rows are intentionally separate from route_proofs and from the
-- compatibility-only actions table. A send is an explicit Base MCP action,
-- not a compared Miorail route and not an Action Inbox recommendation.

CREATE TABLE "base_mcp_action_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"schema_version" text NOT NULL,
	"action_type" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_hash" text NOT NULL,
	"provider_request_id" text,
	"intent_payload" jsonb NOT NULL,
	"durable_proof" jsonb,
	"reconciliation_state" text NOT NULL,
	"transaction_hash" text,
	"block_number" text,
	"response_hash" text,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "base_mcp_action_receipts_tenant_fk" FOREIGN KEY ("tenant_id")
		REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "base_mcp_action_receipts_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "base_mcp_action_receipts_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "base_mcp_action_receipts_schema_check" CHECK ("schema_version" = 'base-mcp-action-receipt/v1'),
	CONSTRAINT "base_mcp_action_receipts_action_check" CHECK ("action_type" IN ('send', 'x402')),
	CONSTRAINT "base_mcp_action_receipts_provider_check" CHECK ("provider" = 'base-mcp'),
	CONSTRAINT "base_mcp_action_receipts_status_check" CHECK ("status" IN (
		'preparing', 'approval_required', 'pending', 'reconciling', 'completed', 'rejected', 'failed'
	)),
	CONSTRAINT "base_mcp_action_receipts_reconciliation_check" CHECK ("reconciliation_state" IN (
		'not_started', 'pending', 'matched', 'provider_confirmed', 'mismatched', 'unavailable'
	)),
	CONSTRAINT "base_mcp_action_receipts_completed_check" CHECK (
		"status" <> 'completed'
		OR ("action_type" = 'send' AND "reconciliation_state" = 'matched')
		OR ("action_type" = 'x402' AND "reconciliation_state" = 'provider_confirmed')
	),
	CONSTRAINT "base_mcp_action_receipts_reconciliation_type_check" CHECK (
		("reconciliation_state" <> 'matched' OR "action_type" = 'send')
		AND ("reconciliation_state" <> 'provider_confirmed' OR "action_type" = 'x402')
	),
	CONSTRAINT "base_mcp_action_receipts_hash_check" CHECK ("action_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "base_mcp_action_receipts_tx_hash_check" CHECK (
		"transaction_hash" IS NULL OR "transaction_hash" ~ '^0x[0-9a-f]{64}$'
	),
	CONSTRAINT "base_mcp_action_receipts_response_hash_check" CHECK (
		"response_hash" IS NULL OR "response_hash" ~ '^0x[0-9a-f]{64}$'
	),
	CONSTRAINT "base_mcp_action_receipts_block_check" CHECK (
		"block_number" IS NULL OR "block_number" ~ '^[0-9]+$'
	)
);
--> statement-breakpoint

CREATE UNIQUE INDEX "base_mcp_action_receipts_tenant_idempotency_unique"
	ON "base_mcp_action_receipts" ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "base_mcp_action_receipts_tenant_created_idx"
	ON "base_mcp_action_receipts" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "base_mcp_action_receipts_tenant_status_idx"
	ON "base_mcp_action_receipts" ("tenant_id", "status", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX "base_mcp_action_receipts_provider_request_idx"
	ON "base_mcp_action_receipts" ("tenant_id", "provider_request_id");
--> statement-breakpoint

CREATE TABLE "base_mcp_action_receipt_events" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_hash" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "base_mcp_action_receipt_events_receipt_fk" FOREIGN KEY ("receipt_id")
		REFERENCES "public"."base_mcp_action_receipts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "base_mcp_action_receipt_events_tenant_fk" FOREIGN KEY ("tenant_id")
		REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "base_mcp_action_receipt_events_sequence_check" CHECK ("sequence" >= 0),
	CONSTRAINT "base_mcp_action_receipt_events_hash_check" CHECK ("event_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "base_mcp_action_receipt_events_status_check" CHECK ("status" IN (
		'preparing', 'approval_required', 'pending', 'reconciling', 'completed', 'rejected', 'failed'
	))
);
--> statement-breakpoint

CREATE UNIQUE INDEX "base_mcp_action_receipt_events_sequence_unique"
	ON "base_mcp_action_receipt_events" ("receipt_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "base_mcp_action_receipt_events_hash_unique"
	ON "base_mcp_action_receipt_events" ("event_hash");
--> statement-breakpoint
CREATE INDEX "base_mcp_action_receipt_events_tenant_created_idx"
	ON "base_mcp_action_receipt_events" ("tenant_id", "created_at" DESC);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION base_mcp_action_receipt_events_append_only()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'base_mcp_action_receipt_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER base_mcp_action_receipt_events_no_update
	BEFORE UPDATE OR DELETE ON "base_mcp_action_receipt_events"
	FOR EACH ROW EXECUTE FUNCTION base_mcp_action_receipt_events_append_only();
