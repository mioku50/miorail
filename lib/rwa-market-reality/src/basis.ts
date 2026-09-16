import {
  MarketRealityBasisDecisionV1Schema,
  type MarketRealityBasisDecisionV1,
  type MarketRealityReferenceStateV1,
} from '@mioagent/route-storage';

export interface MarketRealityBasisInputV1 {
  issuerId: 'coinbase' | 'dinari' | 'backed' | null;
  marketStatus: 'quoted' | 'no_route' | 'unsized' | 'measurement_failed';
  quoteObservedAt: string;
  quoteExpiresAt: string;
  evaluatedAt: string;
  normalizedExposureAtomic: string | null;
  effectivePriceAtomic: string | null;
  effectivePriceDecimals: 8 | null;
  supplyState: 'positive_supply' | 'zero_supply' | 'supply_unknown';
  reference: MarketRealityReferenceStateV1;
}

/** Every decision this module makes now carries v2. v1 rows stay v1: a stored
 * decision keeps the policy it was decided by. */
const BASIS_POLICY_V2 = 'exact_normalized_price_same_quote_window_placed_publication_v2' as const;

function withheldV1(
  reasonCode: Exclude<
    MarketRealityBasisDecisionV1['reasonCode'],
    | 'current_reference_comparable'
    | 'last_close_reference_comparable'
    | 'off_session_reference_comparable'
  >,
  reason: string,
): MarketRealityBasisDecisionV1 {
  return MarketRealityBasisDecisionV1Schema.parse({
    policy: BASIS_POLICY_V2,
    status: 'withheld',
    kind: 'withheld',
    premiumDiscountBps: null,
    reasonCode,
    reason,
  });
}

/**
 * Deterministic basis gate, v2.
 *
 * Health is read, never redefined here. Comparability additionally requires:
 * an exact normalized USDC price, positive reviewed supply, an open quote,
 * reference evidence observed inside that quote's own window, and a feed
 * publication the reviewed calendar can place. The 26-hour feed-health TTL is
 * deliberately absent from this policy.
 *
 * v1 required that publication to fall INSIDE a reviewed regular session, on
 * the configured belief that these feeds hold their last close outside one.
 * Sixty measured rounds (2026-09-16) say they do not: they print overnight
 * with a new value each time. So v1 withheld the comparison exactly when the
 * reference was freshest, and would have labelled an overnight print a close.
 * v2 places the publication instead and lets the placement name the kind —
 * the number is never published without saying which of the three it is.
 */
export function evaluateMarketRealityBasisV1(
  input: MarketRealityBasisInputV1,
): MarketRealityBasisDecisionV1 {
  // Supply is the representation's admission gate to the active market
  // denominator. A router may have failed, refused or never been called, but
  // none of those observations is the reason a reviewed zero-supply address
  // has no basis. Keeping this first prevents infrastructure state from
  // overwriting the stronger exact-address onchain fact.
  if (input.supplyState === 'zero_supply') {
    return withheldV1(
      'zero_supply',
      'Zero supply is outside the active market comparison.',
    );
  }
  if (input.supplyState !== 'positive_supply') {
    return withheldV1(
      'supply_unknown',
      'Positive outstanding supply is not established for this exact representation.',
    );
  }
  if (input.marketStatus === 'no_route') {
    return withheldV1('no_route', 'No approved route returned a quote for this exact question.');
  }
  if (input.marketStatus === 'unsized') {
    return withheldV1(
      'unsized_sell',
      'SELL was not sized because the exact BUY sizing anchor was not established.',
    );
  }
  if (input.marketStatus !== 'quoted') {
    // Says the measurement did not complete, and stops short of naming whose
    // fault that was. `marketStatus` folds several endings into one word, and
    // one of them is a venue REFUSING to quote on its own trading rules — a
    // card whose chip says the venue declined and whose basis line says
    // "provider failure" is two answers to one question on one screen.
    return withheldV1(
      'measurement_failed',
      'The market measurement did not complete, and an incomplete measurement is not an asset-price claim.',
    );
  }
  if (input.issuerId !== 'coinbase') {
    return withheldV1(
      'unreviewed_issuer_reference',
      'This exact issuer representation has no reviewed reference adapter.',
    );
  }

  // Quote validity is evaluated before economic-unit availability. A quote
  // that once carried a normalized amount but has closed is no longer a
  // current price question; callers must not relabel it as a generic missing
  // normalization failure merely because current-price fields are withheld.
  const quoteObservedMs = Date.parse(input.quoteObservedAt);
  const quoteExpiresMs = Date.parse(input.quoteExpiresAt);
  const evaluatedMs = Date.parse(input.evaluatedAt);
  if (
    !Number.isFinite(quoteObservedMs) ||
    !Number.isFinite(quoteExpiresMs) ||
    !Number.isFinite(evaluatedMs) ||
    quoteExpiresMs <= quoteObservedMs ||
    evaluatedMs < quoteObservedMs ||
    evaluatedMs >= quoteExpiresMs
  ) {
    return withheldV1('expired_quote', 'The exact executable quote is no longer open.');
  }
  if (
    input.normalizedExposureAtomic === null ||
    input.effectivePriceAtomic === null ||
    input.effectivePriceDecimals !== 8 ||
    BigInt(input.normalizedExposureAtomic) <= 0n
  ) {
    return withheldV1(
      'missing_normalized_exposure',
      'A price for the reviewed normalized economic exposure was not established.',
    );
  }

  const reference = input.reference;
  if (reference.reasonCode === 'reference_identity_mismatch') {
    return withheldV1(
      'reference_identity_mismatch',
      'Reference evidence does not match the exact reviewed representation and feed address.',
    );
  }
  if (reference.reasonCode === 'reference_read_failed') {
    return withheldV1(
      'reference_read_failed',
      'The reference read failed; a provider failure cannot become a price comparison.',
    );
  }
  if (
    ['issuer_reference_not_reviewed', 'exact_representation_not_reviewed'].includes(
      reference.reasonCode,
    )
  ) {
    return withheldV1(
      'unreviewed_issuer_reference',
      'The exact issuer/reference relationship has not been reviewed.',
    );
  }
  if (reference.status === 'paused' || reference.publicationMode === 'corporate_action_hold') {
    return withheldV1(
      'corporate_action_hold',
      'The reviewed issuer registry establishes a corporate-action publication hold.',
    );
  }
  if (reference.status === 'stale' || reference.publicationMode === 'stale') {
    return withheldV1(
      'reference_stale',
      'The reference is stale under its existing health policy.',
    );
  }
  if (
    reference.status !== 'fresh' ||
    reference.valueAtomic === null ||
    reference.decimals === null ||
    reference.observedAt === null ||
    reference.referenceUpdatedAt === null ||
    reference.referenceAddress === null ||
    reference.evidence === null ||
    reference.calendar === null
  ) {
    return withheldV1('reference_unknown', 'Complete reviewed reference evidence is unavailable.');
  }
  if (BigInt(reference.valueAtomic) <= 0n) {
    return withheldV1('reference_price_invalid', 'The reviewed reference price is not positive.');
  }

  const referenceObservedMs = Date.parse(reference.observedAt);
  if (
    !Number.isFinite(referenceObservedMs) ||
    referenceObservedMs < quoteObservedMs ||
    referenceObservedMs >= quoteExpiresMs
  ) {
    return withheldV1(
      'reference_timing_outside_quote_window',
      'The reference observation was not taken inside the exact router quote window.',
    );
  }

  // The placement is computed where the reviewed calendar lives, against the
  // feed's own `referenceUpdatedAt`. Reading it here rather than recomputing a
  // timezone is deliberate: one definition of "which session did this value
  // come from", used both by the label and by this gate.
  if (
    reference.publicationPlacement === undefined ||
    reference.publicationPlacement === 'not_classified'
  ) {
    return withheldV1(
      'reference_publication_outside_reviewed_session',
      'The reviewed calendar could not place the feed publication in any session.',
    );
  }
  if (reference.publicationPlacement === 'before_last_close') {
    return withheldV1(
      'reference_publication_precedes_last_close',
      'A whole reviewed session has opened and closed since the feed last published.',
    );
  }

  const kind =
    reference.publicationPlacement === 'inside_open_session' &&
    reference.marketSession === 'regular_hours' &&
    reference.publicationMode === 'live_reference'
      ? 'current_reference'
      : reference.publicationPlacement === 'last_closed_session' &&
          reference.publicationMode === 'holding_last_close'
        ? 'last_close_reference'
        : reference.publicationPlacement === 'after_last_close' &&
            reference.publicationMode === 'live_reference'
          ? 'off_session_reference'
          : null;
  if (!kind) {
    return withheldV1(
      'unsupported_semantics',
      'The reviewed market-session/publication-mode pair is not comparable under this policy.',
    );
  }

  const price = BigInt(input.effectivePriceAtomic);
  const referenceValue = BigInt(reference.valueAtomic);
  const priceScale = 10n ** BigInt(input.effectivePriceDecimals);
  const referenceScale = 10n ** BigInt(reference.decimals);
  const numerator = price * referenceScale - referenceValue * priceScale;
  const denominator = referenceValue * priceScale;
  const premiumDiscountBps = ((numerator * 10_000n) / denominator).toString();
  return MarketRealityBasisDecisionV1Schema.parse({
    policy: BASIS_POLICY_V2,
    status: 'comparable',
    kind,
    premiumDiscountBps,
    reasonCode:
      kind === 'current_reference'
        ? 'current_reference_comparable'
        : kind === 'last_close_reference'
          ? 'last_close_reference_comparable'
          : 'off_session_reference_comparable',
    reason:
      kind === 'current_reference'
        ? 'Exact normalized execution price is comparable with the current reviewed publication.'
        : kind === 'last_close_reference'
          ? 'Exact normalized execution price is comparable with the reviewed last-close publication.'
          : 'Exact normalized execution price is comparable with the feed’s own off-session publication.',
  });
}

export function unrecordedMarketRealityBasisV1(): MarketRealityBasisDecisionV1 {
  return withheldV1(
    'not_recorded',
    'This evidence predates Phase 10C.2A and no basis context was recorded.',
  );
}
