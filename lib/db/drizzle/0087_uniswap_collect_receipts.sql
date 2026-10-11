-- Found's Uniswap v3 collect: only the position manager's Collect events,
-- one per prepared position and paying this wallet, finalize it as matched.
ALTER TABLE "base_mcp_action_receipts"
  DROP CONSTRAINT "base_mcp_action_receipts_action_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  ADD CONSTRAINT "base_mcp_action_receipts_action_check"
  CHECK ("action_type" IN ('send', 'x402', 'virtuals', 'aerodrome_claim', 'uniswap_collect'));
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  DROP CONSTRAINT "base_mcp_action_receipts_completed_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  ADD CONSTRAINT "base_mcp_action_receipts_completed_check" CHECK (
    "status" <> 'completed'
    OR ("action_type" IN ('send', 'aerodrome_claim', 'uniswap_collect') AND "reconciliation_state" = 'matched')
    OR ("action_type" IN ('x402', 'virtuals') AND "reconciliation_state" = 'provider_confirmed')
  );
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  DROP CONSTRAINT "base_mcp_action_receipts_reconciliation_type_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  ADD CONSTRAINT "base_mcp_action_receipts_reconciliation_type_check" CHECK (
    ("reconciliation_state" <> 'matched' OR "action_type" IN ('send', 'aerodrome_claim', 'uniswap_collect'))
    AND ("reconciliation_state" <> 'provider_confirmed' OR "action_type" IN ('x402', 'virtuals'))
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "base_mcp_uniswap_collect_active_wallet_unique"
  ON "base_mcp_action_receipts" ("tenant_id", "wallet_address")
  WHERE "action_type" = 'uniswap_collect'
    AND "status" IN ('preparing', 'approval_required', 'pending', 'reconciling');
