-- The half-finished swap goal a clarification leaves behind.
--
-- When the engine answers "which exact Base token should be swapped?", the
-- fields it DID ground are worth keeping for one short window, so the user can
-- answer the question instead of retyping the sentence.
--
-- WHY THIS IS A TABLE AND NOT A FIELD IN THE RESPONSE. The pending intent
-- carries an amount, a pair and the constraints the user asked for. Handing it
-- to the client and taking it back would let a caller state values that
-- appeared in no message — and re-deriving every field from the user's own
-- words is the entire security design of the intent engine. The client never
-- sees this row; the server looks it up by the authenticated tenant and wallet.
--
-- AT MOST ONE PER WALLET, enforced by the primary key. The engine already
-- treats two matching pending intents as ambiguous and refuses to continue, so
-- the storage makes that case unreachable rather than merely handled.
--
-- CONSTRAINTS ARE STORED AS "STATED OR NULL", NEVER AS DEFAULTS. A user who
-- asked for 1% slippage must still get 1% after answering "ETH"; a user who
-- asked for nothing must not inherit a choice they never made. `any` is
-- therefore not a storable protocol mode — it is the absence of one, i.e. NULL.
CREATE TABLE "swap_pending_intents" (
	"tenant_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"source_request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"amount_decimal" text,
	"from_asset_symbol" text,
	"to_asset_symbol" text,
	"optimization_mode" text,
	"verification_depth" text,
	"protocol_mode" text,
	"protocol_names" text[],
	"slippage_max_bps" integer,
	"execution_requested" boolean,
	CONSTRAINT "swap_pending_intents_pkey" PRIMARY KEY ("tenant_id", "wallet_address"),
	CONSTRAINT "swap_pending_intents_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	-- Base mainnet only, the same binding the authenticated runtime carries.
	CONSTRAINT "swap_pending_intents_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "swap_pending_intents_window_check" CHECK ("expires_at" > "created_at"),
	-- An exact decimal amount or nothing. A percentage or an estimate is never
	-- an intent field, and storing one would make it look like one later.
	CONSTRAINT "swap_pending_intents_amount_check" CHECK (
		"amount_decimal" IS NULL OR "amount_decimal" ~ '^\d+(\.\d+)?$'
	),
	CONSTRAINT "swap_pending_intents_assets_check" CHECK (
		("from_asset_symbol" IS NULL OR "from_asset_symbol" IN ('USDC', 'ETH', 'WETH'))
		AND ("to_asset_symbol" IS NULL OR "to_asset_symbol" IN ('USDC', 'ETH', 'WETH'))
		-- The same asset on both sides is not a swap. The engine refuses to build
		-- such a pending intent; the table refuses to hold one.
		AND ("from_asset_symbol" IS NULL OR "to_asset_symbol" IS NULL
			OR "from_asset_symbol" <> "to_asset_symbol")
	),
	-- Something must be worth continuing, or the row is noise that would keep a
	-- stale wallet binding alive for ten minutes.
	CONSTRAINT "swap_pending_intents_substance_check" CHECK (
		"amount_decimal" IS NOT NULL OR "from_asset_symbol" IS NOT NULL
		OR "to_asset_symbol" IS NOT NULL
	),
	CONSTRAINT "swap_pending_intents_optimization_check" CHECK (
		"optimization_mode" IS NULL OR "optimization_mode" IN (
			'best_net_result', 'lowest_fees', 'lowest_risk',
			'fastest_execution', 'simplest_route', 'mev_protected'
		)
	),
	-- 'standard' is the default depth, so it is stored as NULL like every other
	-- unstated value.
	CONSTRAINT "swap_pending_intents_verification_check" CHECK (
		"verification_depth" IS NULL OR "verification_depth" IN ('enhanced', 'maximum')
	),
	CONSTRAINT "swap_pending_intents_slippage_check" CHECK (
		"slippage_max_bps" IS NULL
		OR ("slippage_max_bps" BETWEEN 0 AND 10000)
	),
	-- A mode without protocols constrains nothing, and protocols without a mode
	-- say nothing about what to do with them.
	--
	-- `protocol_mode IS NOT NULL` is not redundant with the IN list: SQL's
	-- three-valued logic makes `NULL IN ('include_only','exclude')` evaluate to
	-- NULL, and a CHECK passes on NULL — only FALSE rejects. Without it, a row
	-- with protocol names and no mode was accepted.
	CONSTRAINT "swap_pending_intents_protocol_check" CHECK (
		("protocol_mode" IS NULL AND "protocol_names" IS NULL)
		OR (
			"protocol_mode" IS NOT NULL
			AND "protocol_mode" IN ('include_only', 'exclude')
			AND "protocol_names" IS NOT NULL
			AND array_length("protocol_names", 1) > 0
			AND "protocol_names" <@ ARRAY['uniswap', 'kyberswap']::text[]
		)
	)
);

-- Expiry is the only sweep this table needs, and it runs on every read.
CREATE INDEX "swap_pending_intents_expires_at_idx" ON "swap_pending_intents" ("expires_at");
