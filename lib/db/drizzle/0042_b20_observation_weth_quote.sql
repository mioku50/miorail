-- Wrapped ETH is a venue Miorail was refusing to read.
--
-- Migration 0032 opened this column to native ETH because every B20 v4 pool
-- sampled was ETH-quoted. It closed the set at two assets, deliberately, so
-- that no long-tail pair could masquerade as a comparable measurement.
--
-- Measured 2026-08-15 over 120 launches whose latest observation said Miorail
-- had found no venue at all: 102 had no Uniswap v4 Initialize log within ten
-- thousand blocks and are correctly reported; 9 had a readable pool that the
-- ten-block search window missed; and 9 had a pool that EXISTED and was
-- refused as `unsupported_quote_asset` — every one of the 9 quoted against
-- 0x4200000000000000000000000000000000000006, the canonical Base WETH
-- predeploy.
--
-- Those cards told the user "Miorail has not found where this trades", which
-- was false. Miorail found where they trade and declined to read it.
--
-- The set stays CLOSED, and the exclusion reasoning is unchanged: a pool priced
-- in another long-tail token gives an exit denominated in something the holder
-- must then exit from as well. Wrapped ETH is not that — it is ETH with an
-- ERC-20 interface, at the same eighteen decimals.
--
-- This widens OBSERVATION only. Clearances, entry plans and approvals remain
-- pinned to USDC in `OPPORTUNITY_QUOTE_ASSET_V1`, so a WETH-quoted observation
-- can be shown on a card and can never become a transaction.
ALTER TABLE "b20_opportunity_observations"
	DROP CONSTRAINT "b20_observations_quote_asset_check";
--> statement-breakpoint
ALTER TABLE "b20_opportunity_observations"
	ADD CONSTRAINT "b20_observations_quote_asset_check" CHECK (
		"reference_quote_asset" IN (
			'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
			'0x0000000000000000000000000000000000000000',
			'0x4200000000000000000000000000000000000006'
		)
	);
