-- The venue decides the pair, not the profile.
--
-- Migration 0029 pinned an observation's reference asset to USDC, on the
-- assumption that a B20 round trip starts and ends in USDC. It does not: every
-- B20 Uniswap v4 pool sampled on 2026-08-09 (11 of 11 resolved) is quoted
-- against NATIVE ETH. With the column pinned, an ETH-quoted measurement could
-- only be stored by mislabelling it — which is what happened, and it recorded
-- a 1e8 wei dust trade as a 100 USDC position.
--
-- The set stays CLOSED, to the two assets B20 pools actually use. An open
-- column would let any pair masquerade as a comparable measurement, and the
-- feed's costs and capacities are only comparable within one pair.
--
-- This widens OBSERVATION only. Clearances, entry plans and approvals remain
-- pinned to USDC in `OPPORTUNITY_QUOTE_ASSET_V1`, so an ETH-quoted observation
-- can be shown on a card and can never become a transaction.
ALTER TABLE "b20_opportunity_observations"
	DROP CONSTRAINT "b20_observations_quote_asset_check";
--> statement-breakpoint
ALTER TABLE "b20_opportunity_observations"
	ADD CONSTRAINT "b20_observations_quote_asset_check" CHECK (
		"reference_quote_asset" IN (
			'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
			'0x0000000000000000000000000000000000000000'
		)
	);
