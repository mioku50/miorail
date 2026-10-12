-- Found's claims may ride the wallet the person is using on the page instead
-- of Coinbase's Wallet MCP: in Farcaster, Base App or a browser wallet the
-- claim is one confirmation there, and no Base Account is needed. Only those
-- two action types may: every other action is Wallet MCP's alone.
ALTER TABLE "base_mcp_action_receipts"
  DROP CONSTRAINT "base_mcp_action_receipts_provider_check";
--> statement-breakpoint
ALTER TABLE "base_mcp_action_receipts"
  ADD CONSTRAINT "base_mcp_action_receipts_provider_check" CHECK (
    "provider" = 'base-mcp'
    OR ("provider" = 'wallet' AND "action_type" IN ('aerodrome_claim', 'uniswap_collect'))
  );
