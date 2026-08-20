-- Reviewed Base plugin runtime: typed Virtuals actions and encrypted sessions.

ALTER TABLE "base_mcp_action_receipts"
	DROP CONSTRAINT "base_mcp_action_receipts_action_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
	ADD CONSTRAINT "base_mcp_action_receipts_action_check"
	CHECK ("action_type" IN ('send', 'x402', 'virtuals'));
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
	DROP CONSTRAINT "base_mcp_action_receipts_completed_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
	ADD CONSTRAINT "base_mcp_action_receipts_completed_check" CHECK (
		"status" <> 'completed'
		OR ("action_type" = 'send' AND "reconciliation_state" = 'matched')
		OR ("action_type" IN ('x402', 'virtuals') AND "reconciliation_state" = 'provider_confirmed')
	);
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
	DROP CONSTRAINT "base_mcp_action_receipts_reconciliation_type_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
	ADD CONSTRAINT "base_mcp_action_receipts_reconciliation_type_check" CHECK (
		("reconciliation_state" <> 'matched' OR "action_type" = 'send')
		AND ("reconciliation_state" <> 'provider_confirmed' OR "action_type" IN ('x402', 'virtuals'))
	);
--> statement-breakpoint

CREATE TABLE "base_mcp_plugin_sessions" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"wallet_address" text NOT NULL,
	"encrypted_session" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_mcp_plugin_sessions_tenant_fk" FOREIGN KEY ("user_id")
		REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
	CONSTRAINT "base_mcp_plugin_sessions_provider_check" CHECK ("provider" = 'virtuals'),
	CONSTRAINT "base_mcp_plugin_sessions_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "base_mcp_plugin_sessions_user_provider_unique"
	ON "base_mcp_plugin_sessions" ("user_id", "provider");
--> statement-breakpoint
CREATE INDEX "base_mcp_plugin_sessions_expires_idx"
	ON "base_mcp_plugin_sessions" ("expires_at");
