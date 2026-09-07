-- What actually sits in the pools that hold a token.
--
-- Use & access answered "is this token in DeFi?" with four LENDING venues and
-- nothing else, so NVDAc — whose largest onchain use by a wide margin is an
-- Aerodrome concentrated-liquidity pool holding 3,740 NVDAc against $1.61m of
-- USDC — read as a token with almost no DeFi presence. The pools were already
-- discovered: `market_venues` knew thirty-nine of them. Nothing measured what
-- was in them, so nothing could be said.
--
-- A COUNT would have been worse than silence. Twenty-four of those thirty-nine
-- are Uniswap v3 pairs against memecoins — 71 NVDAc against 212 million KUMA,
-- 46 against 293 million NAVIDIA — and "39 pools" would have been true
-- arithmetic about a market that does not exist. So the row carries the
-- measured balance of both sides, and the screen ranks by it.
--
-- One row per (pool, token): the newest reading, overwritten in place. The row
-- IS the current fact and carries its own block and clock, exactly like every
-- other measurement in this product. History lives in the ledger the tail
-- already writes, not here.
CREATE TABLE IF NOT EXISTS "market_pool_readings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"pool_address" text NOT NULL,
	"token_address" text NOT NULL,
	-- Which venue this pool belongs to, decided by reading the chain and never
	-- by a name a router handed us. `venue_id` is null when the factory
	-- answered but is not one we have identified: unidentified is a state, and
	-- it must not be rendered as absent.
	"venue_id" text,
	"factory_address" text,
	"token_balance_atomic" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"paired_token_address" text,
	"paired_balance_atomic" text,
	"paired_decimals" integer,
	"paired_symbol" text,
	"block_number" bigint NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "market_pool_readings_unique" UNIQUE ("chain_id", "pool_address", "token_address")
);
--> statement-breakpoint

-- Addresses are stored lowercase everywhere in this schema, and a mixed-case
-- duplicate would defeat the unique constraint above rather than error.
ALTER TABLE "market_pool_readings"
	ADD CONSTRAINT "market_pool_readings_pool_shape" CHECK ("pool_address" ~ '^0x[0-9a-f]{40}$');
--> statement-breakpoint
ALTER TABLE "market_pool_readings"
	ADD CONSTRAINT "market_pool_readings_token_shape" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$');
--> statement-breakpoint
ALTER TABLE "market_pool_readings"
	ADD CONSTRAINT "market_pool_readings_paired_shape" CHECK (
		"paired_token_address" IS NULL OR "paired_token_address" ~ '^0x[0-9a-f]{40}$'
	);
--> statement-breakpoint
ALTER TABLE "market_pool_readings"
	ADD CONSTRAINT "market_pool_readings_factory_shape" CHECK (
		"factory_address" IS NULL OR "factory_address" ~ '^0x[0-9a-f]{40}$'
	);
--> statement-breakpoint

-- Balances are atomic integers, never floats: a pool holding 1,614,910.95 USDC
-- is 1614910950000 and rounding it once is rounding it forever.
ALTER TABLE "market_pool_readings"
	ADD CONSTRAINT "market_pool_readings_balance_digits" CHECK ("token_balance_atomic" ~ '^[0-9]+$');
--> statement-breakpoint
ALTER TABLE "market_pool_readings"
	ADD CONSTRAINT "market_pool_readings_paired_balance_digits" CHECK (
		"paired_balance_atomic" IS NULL OR "paired_balance_atomic" ~ '^[0-9]+$'
	);
--> statement-breakpoint

-- The paired side is all-or-nothing. A row carrying an amount with no token to
-- denominate it, or a token with no amount, is a half-read pretending to be a
-- reading, and the screen would have to invent the missing half to render it.
ALTER TABLE "market_pool_readings"
	ADD CONSTRAINT "market_pool_readings_paired_complete" CHECK (
		("paired_token_address" IS NULL AND "paired_balance_atomic" IS NULL AND "paired_decimals" IS NULL)
		OR ("paired_token_address" IS NOT NULL AND "paired_balance_atomic" IS NOT NULL AND "paired_decimals" IS NOT NULL)
	);
--> statement-breakpoint

ALTER TABLE "market_pool_readings"
	ADD CONSTRAINT "market_pool_readings_decimals_range" CHECK (
		"token_decimals" BETWEEN 0 AND 36
		AND ("paired_decimals" IS NULL OR "paired_decimals" BETWEEN 0 AND 36)
	);
--> statement-breakpoint

-- The read order the screen wants: every pool holding one token, deepest
-- first. Ranking by measured balance is the whole point — a count would put a
-- memecoin pair beside the book that holds the money.
CREATE INDEX IF NOT EXISTS "market_pool_readings_token_idx"
	ON "market_pool_readings" ("chain_id", "token_address", "block_number" DESC);
