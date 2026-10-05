-- Only reviewed Aerodrome claim events can finalize this action as matched.
ALTER TABLE "base_mcp_action_receipts"
  DROP CONSTRAINT "base_mcp_action_receipts_action_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  ADD CONSTRAINT "base_mcp_action_receipts_action_check"
  CHECK ("action_type" IN ('send', 'x402', 'virtuals', 'aerodrome_claim'));
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  DROP CONSTRAINT "base_mcp_action_receipts_completed_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  ADD CONSTRAINT "base_mcp_action_receipts_completed_check" CHECK (
    "status" <> 'completed'
    OR ("action_type" IN ('send', 'aerodrome_claim') AND "reconciliation_state" = 'matched')
    OR ("action_type" IN ('x402', 'virtuals') AND "reconciliation_state" = 'provider_confirmed')
  );
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  DROP CONSTRAINT "base_mcp_action_receipts_reconciliation_type_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  ADD CONSTRAINT "base_mcp_action_receipts_reconciliation_type_check" CHECK (
    ("reconciliation_state" <> 'matched' OR "action_type" IN ('send', 'aerodrome_claim'))
    AND ("reconciliation_state" <> 'provider_confirmed' OR "action_type" IN ('x402', 'virtuals'))
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "base_mcp_aerodrome_claim_active_wallet_unique"
  ON "base_mcp_action_receipts" ("tenant_id", "wallet_address")
  WHERE "action_type" = 'aerodrome_claim'
    AND "status" IN ('preparing', 'approval_required', 'pending', 'reconciling');
