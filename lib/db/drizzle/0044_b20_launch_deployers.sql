-- The sender of the launch transaction: the only unforgeable identity anchor
-- Miorail can read.
--
-- Everything identifying in `b20_launches` is written by whoever launched the
-- token. `name` and `symbol` are strings in a log — a launch calling itself
-- AVANTIS costs nothing and proves nothing. Resolving a project by matching
-- those strings would let one launch inherit another project's profile, with
-- Miorail vouching for the impostor. So the anchor has to be something the
-- chain decided rather than something the launcher typed, and there is exactly
-- one such field available: who sent the transaction the launch log came from.
--
-- WHY ITS OWN TABLE, AND NOT A COLUMN ON `b20_launches`:
--
--   That table is the DECODED LOG and nothing else. It is immutable chain
--   evidence with a trigger enforcing it, and every field in it came from the
--   same read at the same moment. The sender comes from a DIFFERENT read —
--   eth_getTransactionByHash, taken later, against an endpoint that can be
--   down — and giving it its own dated row keeps three states distinguishable
--   that a nullable column would collapse into one:
--
--     no row          nobody has read this launch's transaction yet
--     row, sender     the endpoint answered and this is what it said
--     row, no sender  the endpoint answered and the transaction was not there
--
--   A NULL column cannot tell "not read" from "read and absent", and this
--   product's recurring bug is exactly that confusion printed as a finding.
--
-- WHAT THIS IS NOT:
--
--   Not an identity. A sender address is an address; it is not a team, not a
--   company, and not a reputation. What it supports is counting: how many
--   other launches came from the same sender, and what Miorail measured about
--   those. Those counts are facts about a corpus, computed from stored rows.
--
--   Not a claim. A project asserting "this token is ours" is a separate thing
--   with its own table and its own verification, and the default there is
--   unverified.
CREATE TABLE IF NOT EXISTS "b20_launch_deployers" (
	-- The launch id: `${transaction_hash}:${log_index}`. One launch, one
	-- reading — a retry writes the same row rather than a second one.
	"launch_id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	-- Lowercase, because every comparison here is equality against another
	-- stored address and a checksummed copy would silently never match.
	--
	-- Nullable, and null means the endpoint ANSWERED and the transaction was
	-- not there — a reorged-away transaction, or an endpoint serving a shorter
	-- history than it claims. A failed read writes no row at all.
	"deployer_address" text,
	-- What the transaction said it created, when it created a contract
	-- directly. Recorded but never used as the token identity: the B20 factory
	-- is the `to` on these transactions, so this is null in the ordinary case
	-- and its presence is itself worth seeing.
	"transaction_to" text,
	-- The block the transaction was mined in, as the endpoint reported it.
	-- Compared against the launch's own block: a mismatch means the two reads
	-- disagree about the same transaction, and that is a fact worth keeping
	-- rather than resolving in favour of whichever arrived second.
	"transaction_block_number" numeric(78, 0),
	"read_at" timestamp with time zone NOT NULL,
	-- Which endpoint family answered. NOT a URL and never a key: an endpoint
	-- string in a table is a credential waiting to be selected into a log.
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_launch_deployers_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_launch_deployers_address_check"
		CHECK ("deployer_address" IS NULL OR "deployer_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_launch_deployers_to_check"
		CHECK ("transaction_to" IS NULL OR "transaction_to" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_launch_deployers_block_check"
		CHECK ("transaction_block_number" IS NULL OR "transaction_block_number" >= 0),
	-- A source that names a host would put an endpoint, and eventually a key,
	-- into rows that get selected into diagnostics.
	CONSTRAINT "b20_launch_deployers_source_check" CHECK ("source" IN ('base-rpc/v1'))
);
--> statement-breakpoint
-- The read this whole table exists to serve: every launch from one sender.
CREATE INDEX IF NOT EXISTS "b20_launch_deployers_deployer_idx"
	ON "b20_launch_deployers" ("chain_id", "deployer_address");
--> statement-breakpoint

-- A project's claim on a token — asserted, never inferred.
--
-- The rule this table exists to enforce is that Miorail does not guess who is
-- behind a token. A claim is made, and then it is either verified by one of
-- three checkable links or it stays unverified:
--
--   launch_sender        the launch transaction's sender is an address the
--                        project had already published as theirs
--   domain_file          a file served from the project's own domain names
--                        this token address
--   project_publication  the project published the token address itself, on a
--                        surface it controls
--
-- `unverified` is the DEFAULT and the resting state. It is not a failure and
-- it is not an accusation: almost every launch on this chain will never have a
-- claim at all, and a surface showing "unverified" is stating what Miorail
-- checked rather than what the project is.
--
-- There is deliberately NO SCORE. Miorail publishes "verified 1 of 3" and the
-- checklist beside it, never a number that folds unlike evidence together with
-- weights nobody can justify — a ranked list of tokens is an investment signal,
-- whatever it is called.
CREATE TABLE IF NOT EXISTS "b20_token_claims" (
	-- `${chain_id}:${token_address}:${claimant}` — derived, so one claimant
	-- cannot hold two competing rows for one token.
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	-- The domain the claim is made ON BEHALF OF, lowercase, no scheme and no
	-- path. It is the claimant's identity here, because it is the thing the
	-- domain_file check can actually verify against.
	"claimant_domain" text NOT NULL,
	-- The address the project says is theirs, when they name one. Verified
	-- only by comparison against a launch's stored sender.
	"claimed_sender_address" text,
	"status" text NOT NULL,
	-- Which links were checked and what each one said. One row per claim,
	-- because a check is not a fact about the token — it is a fact about this
	-- claim at the time it ran.
	"verified_links" text[] NOT NULL DEFAULT '{}',
	"refuted_links" text[] NOT NULL DEFAULT '{}',
	-- Why the claim is where it is, in the vocabulary above. Null while
	-- nothing has been checked.
	"last_check_reason" text,
	"last_checked_at" timestamp with time zone,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_token_claims_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_token_claims_token_check" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	-- A domain, not a URL. A scheme or a path here would eventually be fetched.
	CONSTRAINT "b20_token_claims_domain_check"
		CHECK ("claimant_domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
	CONSTRAINT "b20_token_claims_sender_check"
		CHECK ("claimed_sender_address" IS NULL OR "claimed_sender_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_token_claims_status_check"
		CHECK ("status" IN ('unverified', 'verified', 'refuted')),
	CONSTRAINT "b20_token_claims_id_check"
		CHECK ("id" = "chain_id"::text || ':' || "token_address" || ':' || "claimant_domain"),
	-- A verified claim must name the link that verified it. "Verified" with an
	-- empty list is the exact vouching-for-an-impostor this table exists to
	-- prevent, and it must be impossible to write rather than discouraged.
	CONSTRAINT "b20_token_claims_verified_needs_link"
		CHECK ("status" <> 'verified' OR array_length("verified_links", 1) >= 1),
	CONSTRAINT "b20_token_claims_refuted_needs_link"
		CHECK ("status" <> 'refuted' OR array_length("refuted_links", 1) >= 1),
	CONSTRAINT "b20_token_claims_links_known" CHECK (
		"verified_links" <@ ARRAY['launch_sender', 'domain_file', 'project_publication']::text[]
		AND "refuted_links" <@ ARRAY['launch_sender', 'domain_file', 'project_publication']::text[]
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "b20_token_claims_token_idx"
	ON "b20_token_claims" ("chain_id", "token_address");
