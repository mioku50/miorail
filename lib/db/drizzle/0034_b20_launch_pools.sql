-- Stop paying two eth_getLogs to re-learn a pool that cannot move.
--
-- `resolveB20PoolV1` issues up to TWO `eth_getLogs` per measurement — one for
-- each side of the pair, because v4 orders currencies by address and the B20
-- token may be either. `createB20PoolCacheV1` already remembers the answer,
-- but only for one pass, and its own comment says the durable cache belongs
-- here. Over the seven days to 2026-08-10 production wrote 101,189
-- observations across 1,477 launches — 68 repeat lookups per token of a fact
-- fixed at launch, using the most expensive call available (getLogs costs
-- roughly three times an eth_call).
--
-- ABSENCE IS CACHED TOO, and that is the subtle part. The resolver searches a
-- fixed window starting at the launch block, so "no pool was initialized in
-- that window" is permanent for that question — a pool created later would not
-- be found by that query either. But it is only permanent FOR THAT WINDOW,
-- which is why the searched range is stored and a reader must check it covers
-- what it is about to ask. Widening the search later must re-ask, not inherit.
--
-- WHAT IS NEVER CACHED: `endpoint_unavailable`. Nothing was learned about the
-- token, and storing it would turn one throttled request into a verdict that
-- outlives the outage. That distinction is the whole reason the resolver keeps
-- its refusals separate, and this table must not collapse them.
CREATE TABLE "b20_launch_pools" (
	"token_address" text PRIMARY KEY NOT NULL,
	-- The exact question that was asked. A reader may only trust this row for a
	-- window this search actually covered.
	"search_from_block" numeric(78,0) NOT NULL,
	"search_to_block" numeric(78,0) NOT NULL,
	"outcome" text NOT NULL,
	"pool_id" text,
	"currency0" text,
	"currency1" text,
	"fee" integer,
	"tick_spacing" integer,
	"hooks" text,
	"quote_asset" text,
	"token_is_currency0" boolean,
	-- The block the Initialize log sat in, not the launch block.
	"pool_block_number" numeric(78,0),
	"resolved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "b20_launch_pools_outcome_check" CHECK ("outcome" IN ('resolved', 'absent')),
	CONSTRAINT "b20_launch_pools_window_check" CHECK ("search_to_block" >= "search_from_block"),
	-- A resolved row carries a whole PoolKey or it is not resolved: a partial
	-- key hashes to a pool id that names nothing, and quoting against it would
	-- fail in a way that looks like the token's fault.
	CONSTRAINT "b20_launch_pools_resolved_complete_check" CHECK (
		("outcome" = 'resolved'
			AND "pool_id" IS NOT NULL AND "currency0" IS NOT NULL AND "currency1" IS NOT NULL
			AND "fee" IS NOT NULL AND "tick_spacing" IS NOT NULL AND "hooks" IS NOT NULL
			AND "quote_asset" IS NOT NULL AND "token_is_currency0" IS NOT NULL
			AND "pool_block_number" IS NOT NULL)
		OR ("outcome" = 'absent'
			AND "pool_id" IS NULL AND "currency0" IS NULL AND "currency1" IS NULL
			AND "fee" IS NULL AND "tick_spacing" IS NULL AND "hooks" IS NULL
			AND "quote_asset" IS NULL AND "token_is_currency0" IS NULL
			AND "pool_block_number" IS NULL)
	),
	-- Lowercase or nothing, for the same reason the observation's hook column
	-- is: a checksummed address compares unequal to a pinned constant and reads
	-- as something unusual rather than as itself.
	CONSTRAINT "b20_launch_pools_address_case_check" CHECK (
		"token_address" ~ '^0x[0-9a-f]{40}$'
		AND ("hooks" IS NULL OR "hooks" ~ '^0x[0-9a-f]{40}$')
		AND ("currency0" IS NULL OR "currency0" ~ '^0x[0-9a-f]{40}$')
		AND ("currency1" IS NULL OR "currency1" ~ '^0x[0-9a-f]{40}$')
		AND ("quote_asset" IS NULL OR "quote_asset" ~ '^0x[0-9a-f]{40}$')
		AND ("pool_id" IS NULL OR "pool_id" ~ '^0x[0-9a-f]{64}$')
	)
);
