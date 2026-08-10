-- The hook is the only part of a B20 venue we can actually verify.
--
-- A B20 token's own code cannot be read: `eth_getCode` returns the single byte
-- `0xef`, `eth_getProof` confirms `codeHash == keccak256(0xef)` with nonce 0,
-- and BaseScan labels it a System Contract with no verified source. So no claim
-- about how a B20 token transfers can be established by reading it.
--
-- Its Uniswap v4 hook is different. v4 encodes a hook's permissions in the low
-- 14 bits of the hook's own ADDRESS, so the permission set is readable by
-- inspection — no bytecode, no RPC, no trust. Measured across 50 launches on
-- 2026-08-10 by reading each launch's own `Initialize` log:
--
--   0x985c14ba…2acc   48 of 50   before_swap, after_swap, both returns_delta,
--                                plus the two liquidity gates
--   0xf85f1f30…20cc    2 of 50   the same swap bits, no liquidity gates
--
-- Not a constant, so it is worth storing. And every pool sampled carried
-- `fee = 0` — a literal zero static fee, not the dynamic-fee flag — while both
-- hooks hold BEFORE_SWAP_RETURNS_DELTA and AFTER_SWAP_RETURNS_DELTA, which is
-- permission to change the amounts of every swap. With no LP fee, the hook is
-- the only thing that can set what exiting costs.
--
-- NULLABLE and outside the evidence hash, both deliberately:
--
--   * NULL is honest for every row written before this column existed and for
--     any venue that is not Uniswap v4. Backfilling a default would invent a
--     hook for observations that never read one.
--   * The evidence hash is untouched because a v4 pool id IS the keccak of its
--     PoolKey, and the PoolKey includes the hook. `entry_source_key` already
--     carries that pool id, so the hook is cryptographically committed there.
--     This column is a denormalisation for display, not new evidence, and
--     hashing it again would change every future hash to prove nothing new.
--
-- The permissions are decoded in code (`v4HookPermissionsV1`) rather than
-- stored, so an address is the whole truth and the interpretation stays where
-- it is tested.
ALTER TABLE "b20_opportunity_observations"
	ADD COLUMN "pool_hook_address" text;
--> statement-breakpoint
-- Lowercase 20-byte address or nothing. A mixed-case or truncated hook would
-- compare unequal to the pinned standard one and silently read as "unusual".
ALTER TABLE "b20_opportunity_observations"
	ADD CONSTRAINT "b20_observations_pool_hook_check" CHECK (
		"pool_hook_address" IS NULL
		OR "pool_hook_address" ~ '^0x[0-9a-f]{40}$'
	);
