-- Preserve an explicitly requested GMGN quote through clarification. This
-- expands storage only: GMGN still has no transaction preparation path.
ALTER TABLE "swap_pending_intents"
  DROP CONSTRAINT "swap_pending_intents_protocol_check";
--> statement-breakpoint
ALTER TABLE "swap_pending_intents"
  ADD CONSTRAINT "swap_pending_intents_protocol_check" CHECK (
    ("protocol_mode" IS NULL AND "protocol_names" IS NULL)
    OR (
      "protocol_mode" IS NOT NULL
      AND "protocol_mode" IN ('include_only', 'exclude')
      AND "protocol_names" IS NOT NULL
      AND array_length("protocol_names", 1) > 0
      AND "protocol_names" <@ ARRAY[
        'uniswap', 'kyberswap', 'aerodrome', 'balancer', 'hydrex', 'o1-exchange', 'gmgn'
      ]::text[]
    )
  );
