-- WHICH spelling of the official asset a contract was wearing.
--
-- Found by running the scan over the real launch index on 2026-08-25: 112
-- contracts matched, and the three ways they matched are not the same finding.
--
--   published ticker (AAPLc, COINc)   12
--   underlying       (AAPL, COIN)     95
--   display name     (Apple)           5
--
-- Nobody names a token `AAPLc` by accident. The trailing `c` is the issuer's
-- own convention, so wearing it is a deliberate choice about how the token
-- will be read. `COIN` and `META` are ordinary English words, and most of the
-- 95 are exactly that -- one is a memecoin called "we like the coin".
--
-- Both are still resemblances and both are still stored: the product says a
-- contract resembles an official asset and that its address does not match,
-- which is true of all 112. What was missing is the ability to say which kind
-- without re-deriving it at read time against a corpus the reader may not
-- have -- and re-derivation at the surface is how a distinction gets lost.
--
-- Not a severity and not a score. It records what matched, not how bad it is,
-- and there is still nothing here to ORDER BY as a judgement.
--
-- The column is NOT NULL with no default because the table is empty: it was
-- created hours earlier by 0053 and the first scan has not been written yet.

ALTER TABLE official_asset_lookalikes
  ADD COLUMN IF NOT EXISTS matched_alias text NOT NULL;

ALTER TABLE official_asset_lookalikes
  DROP CONSTRAINT IF EXISTS official_asset_lookalikes_matched_alias;

ALTER TABLE official_asset_lookalikes
  ADD CONSTRAINT official_asset_lookalikes_matched_alias
  CHECK (matched_alias IN ('published_ticker', 'underlying', 'display_name'));

CREATE INDEX IF NOT EXISTS official_asset_lookalikes_alias_idx
  ON official_asset_lookalikes (chain_id, matched_alias, first_flagged_at DESC);
