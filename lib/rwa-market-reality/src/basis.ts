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

function withheldV1(
  reasonCode: Exclude<
    MarketRealityBasisDecisionV1['reasonCode'],
    'current_reference_comparable' | 'last_close_reference_comparable'
  >,
  reason: string,
): MarketRealityBasisDecisionV1 {
  return MarketRealityBasisDecisionV1Schema.parse({
    policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1',
    status: 'withheld',
    kind: 'withheld',
    premiumDiscountBps: null,
    reasonCode,
    reason,
  });
}

function localDateAndMinuteV1(timestamp: string): { localDate: string; minute: number } | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const value = (kind: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === kind)?.value ?? null;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    const hour = Number(value('hour'));
    const minute = Number(value('minute'));
    if (!year || !month || !day || !Number.isInteger(hour) || !Number.isInteger(minute)) {
      return null;
    }
    return { localDate: `${year}-${month}-${day}`, minute: hour * 60 + minute };
  } catch {
    return null;
  }
}

/**
 * Deterministic Phase 10C.2A basis gate.
 *
 * Health is read, never redefined here. Comparability additionally requires:
 * an exact normalized USDC price, positive reviewed supply, an open quote,
 * reference evidence observed inside that quote's own window, and a source
 * publication timestamp inside the explicitly reviewed regular session. The
 * 26-hour feed-health TTL is deliberately absent from this policy.
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
    return withheldV1(
      'measurement_failed',
      'The market measurement failed; provider failure is not an asset-price claim.',
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

  const publication = localDateAndMinuteV1(reference.referenceUpdatedAt);
  if (
    !publication ||
    publication.localDate !== reference.calendar.publicationSessionLocalDate ||
    publication.minute < reference.calendar.publicationSessionOpenMinute ||
    publication.minute > reference.calendar.publicationSessionCloseMinute
  ) {
    return withheldV1(
      'reference_publication_outside_reviewed_session',
      'The feed publication is not proved to belong to the required reviewed regular session.',
    );
  }

  const kind =
    reference.marketSession === 'regular_hours' && reference.publicationMode === 'live_reference'
      ? 'current_reference'
      : ['after_hours', 'weekend'].includes(reference.marketSession) &&
          reference.publicationMode === 'holding_last_close'
        ? 'last_close_reference'
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
    policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1',
    status: 'comparable',
    kind,
    premiumDiscountBps,
    reasonCode:
      kind === 'current_reference'
        ? 'current_reference_comparable'
        : 'last_close_reference_comparable',
    reason:
      kind === 'current_reference'
        ? 'Exact normalized execution price is comparable with the current reviewed publication.'
        : 'Exact normalized execution price is comparable with the reviewed last-close publication.',
  });
}

export function unrecordedMarketRealityBasisV1(): MarketRealityBasisDecisionV1 {
  return withheldV1(
    'not_recorded',
    'This evidence predates Phase 10C.2A and no basis context was recorded.',
  );
}
