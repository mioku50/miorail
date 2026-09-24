-- A gift from what the wallet already holds: its own goal, 'send'.
--
-- A gift used to be a purchase: the ordinary swap to the giver, then one
-- transfer of the bought stock to the recipient. A person who already holds
-- the stock had to buy it again to give it. A send is the transfer alone —
-- one ERC-20 `transfer` of a reviewed stock from the giver's wallet — with no
-- router, no quote and no swap in the batch.
--
-- It lives where every other route family's execution lives: a run in
-- route_runs, a Blueprint in execution_blueprints, and the proof and its events
-- in route_proofs / route_proof_events, which already carry no goal of their
-- own. Only the two goal checks change. A send run stores a RouteIntentV1 with
-- goal 'send' (the intent schema has always allowed it); its Blueprint is
-- checked by the Gift Send kernel, never the swap one.
--
-- Applied by hand, as the app user, like every migration here. Both tables are
-- owned by miorail_user already, so no ownership changes.

BEGIN;

ALTER TABLE "route_runs" DROP CONSTRAINT IF EXISTS "route_runs_goal_check";
ALTER TABLE "route_runs" ADD CONSTRAINT "route_runs_goal_check"
  CHECK ("goal" IN ('swap', 'earn', 'commerce', 'nft', 'private_ai', 'send'));

ALTER TABLE "execution_blueprints" DROP CONSTRAINT IF EXISTS "execution_blueprints_goal_check";
ALTER TABLE "execution_blueprints" ADD CONSTRAINT "execution_blueprints_goal_check"
  CHECK ("goal" IN ('swap', 'earn', 'send'));

COMMIT;
