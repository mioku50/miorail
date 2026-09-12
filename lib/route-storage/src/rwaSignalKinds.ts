// ---------------------------------------------------------------------------
// The signal kinds, and NOTHING else.
//
// A leaf on purpose: no imports, not even zod. The browser-facing Discover
// contract needs this list, and reaching it through the package index drags in
// every repository behind it -- including one that imports `node:crypto`, which
// the miniapp's webpack build cannot resolve and which broke that build the
// moment the two lists were merged into one.
//
// The alternative was to keep declaring the kinds twice, once here and once in
// the wire schema. That is what was here before, and it is worse: a kind added
// to the store and missing from the schema makes the wire refuse the very rows
// the repository just wrote, and the failure surfaces as a feed that quietly
// stopped growing. One list, in a file light enough for both sides to import.
// ---------------------------------------------------------------------------

/**
 * Every kind, and what each one requires somebody to have observed.
 *
 * There is no `trade` kind. A movement through a venue is not a swap -- 2 of
 * 34 measured transactions were not -- so the two market kinds are driven by a
 * cash-exit round trip that either completed or did not.
 */
export const RWA_SIGNAL_KINDS_V1 = [
  'official_source_added_asset',
  'official_source_removed_asset',
  'official_asset_lookalike_created',
  'official_asset_market_became_active',
  'official_asset_market_became_unreachable',
  'official_asset_cash_exit_changed',
  // The two onchain kinds. Unlike every kind above them, these are not a
  // comparison against a state we had stored -- the log IS the transition, and
  // Base emits it precisely so integrators can catch a corporate action as it
  // executes. The watch rule still applies unchanged: the tail opens its watch
  // before it reads, so a backfill over older blocks records history in
  // `b20_corporate_actions` and reports none of it as news.
  'official_asset_corporate_action_announced',
  'official_asset_multiplier_changed',
] as const;
export type RwaSignalKindV1 = (typeof RWA_SIGNAL_KINDS_V1)[number];

/** The kinds an onchain log produces. Named as a set because one emitter owns
 * both of them and opens one watch for the pair. */
export const RWA_ONCHAIN_SIGNAL_KINDS_V1 = [
  'official_asset_corporate_action_announced',
  'official_asset_multiplier_changed',
] as const;
export type RwaOnchainSignalKindV1 = (typeof RWA_ONCHAIN_SIGNAL_KINDS_V1)[number];
