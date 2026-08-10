-- How concentrated the buying was in a launch's own window.
--
-- The exit-first question: if one wallet took everything that left the pool,
-- your exit is contingent on that wallet not selling first. Measured on
-- 2026-08-10 across ten launches where the rail found BOTH legs — 0, 1, 1, 2,
-- 2, 3, 8, 32 and 76 distinct buyers, top share 13.8% to 100%. Across ten
-- launches picked WITHOUT that filter, eight had no buyer at all, so an empty
-- result is the common and correct one.
--
-- Cached for the same reason the pool is: `mainnet.base.org` serves the whole
-- 10,000-block window in ONE eth_getLogs, and once the window is past, the
-- answer cannot change.
--
-- THE RULE THIS TABLE ADDS OVER 0034: a row may only be written once the
-- window has CLOSED. A launch measured an hour after it happened has most of
-- its window still in the future, and caching that would freeze a partial
-- count as final — a token would show one buyer forever because that is all
-- there were in the first ten minutes. `search_to_block` must be at or below
-- the observed head before anything is stored.
--
-- AGGREGATES ONLY, no addresses. The card needs concentration, not a roster of
-- third-party wallets, and the narrower thing is the one worth keeping.
CREATE TABLE "b20_launch_buyers" (
	"token_address" text PRIMARY KEY NOT NULL,
	"search_from_block" numeric(78,0) NOT NULL,
	"search_to_block" numeric(78,0) NOT NULL,
	"buyer_count" integer NOT NULL,
	"total_bought_atomic" numeric(78,0) NOT NULL,
	-- NULL when nobody bought. A concentration among nobody is not 0% — it is
	-- not a number, and a zero here would render as "0% concentrated", which
	-- reads as the safest possible token rather than an untraded one.
	"top_buyer_share_bps" integer,
	"top_three_share_bps" integer,
	"measured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "b20_launch_buyers_address_check" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_launch_buyers_window_check" CHECK ("search_to_block" > "search_from_block"),
	CONSTRAINT "b20_launch_buyers_count_check" CHECK ("buyer_count" >= 0),
	CONSTRAINT "b20_launch_buyers_share_range_check" CHECK (
		("top_buyer_share_bps" IS NULL OR "top_buyer_share_bps" BETWEEN 0 AND 10000)
		AND ("top_three_share_bps" IS NULL OR "top_three_share_bps" BETWEEN 0 AND 10000)
	),
	-- Shares exist exactly when buyers do, and the top three can never be
	-- smaller than the top one.
	CONSTRAINT "b20_launch_buyers_shares_present_check" CHECK (
		("buyer_count" = 0
			AND "top_buyer_share_bps" IS NULL AND "top_three_share_bps" IS NULL
			AND "total_bought_atomic" = 0)
		OR ("buyer_count" > 0
			AND "top_buyer_share_bps" IS NOT NULL AND "top_three_share_bps" IS NOT NULL
			AND "top_three_share_bps" >= "top_buyer_share_bps"
			AND "total_bought_atomic" > 0)
	)
);
