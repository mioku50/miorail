-- A half-finished swap goal may name PAXG (2026-11-12).
--
-- PAXG (Paxos Gold) joined the trusted swap registry in lib/intent-core, so
-- "Swap USDC to PAXG" asks for the amount and keeps the pair for the answer.
-- The CHECK constraint of 0036 allowed only USDC, ETH and WETH. A row naming
-- PAXG was refused, the refusal was logged and the turn went on, and the next
-- message ("120") arrived with nothing to continue.
--
-- The list here must stay the registry's list (TRUSTED_ASSET_SYMBOLS) and the
-- row type's (route-storage SWAP_PENDING_ASSET_SYMBOLS_V1).
--
-- Re-runnable: the old constraint is dropped if present and the new one added
-- under the same name, inside one transaction.

ALTER TABLE "swap_pending_intents" DROP CONSTRAINT IF EXISTS "swap_pending_intents_assets_check";
--> statement-breakpoint
ALTER TABLE "swap_pending_intents" ADD CONSTRAINT "swap_pending_intents_assets_check" CHECK (
	("from_asset_symbol" IS NULL OR "from_asset_symbol" IN ('USDC', 'ETH', 'WETH', 'PAXG'))
	AND ("to_asset_symbol" IS NULL OR "to_asset_symbol" IN ('USDC', 'ETH', 'WETH', 'PAXG'))
	-- The same asset on both sides is not a swap.
	AND ("from_asset_symbol" IS NULL OR "to_asset_symbol" IS NULL
		OR "from_asset_symbol" <> "to_asset_symbol")
);
