-- The index behind a fundamental predicate.
--
-- A predicate read is `WHERE chain_id = … AND dimension = … AND state = ANY(…)`
-- joined back to the claim, and it runs once per console question. The corpus
-- is tiny today — one verified claim — so this index buys nothing yet, and that
-- is precisely when to add it: the shape of the query is settled now, and the
-- day the corpus is large is not the day to discover the read was a sequential
-- scan over every evidence row on the chain.
--
-- `token_address` rides along so the JOIN back to the claim and the ORDER BY
-- are both served from the index rather than by fetching rows to sort them.
--
-- No index on state alone. There is no query that asks "everything that is
-- live" across dimensions, and there must not be — a state means nothing
-- without the dimension it belongs to.

CREATE INDEX IF NOT EXISTS b20_project_evidence_predicate_idx
  ON b20_project_evidence (chain_id, dimension, state, token_address);
