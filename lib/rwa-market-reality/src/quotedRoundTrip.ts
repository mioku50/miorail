/** A signed difference between two router quotes, never an executed return.
 * Stored costs are integer basis points rounded towards zero. Zero therefore
 * cannot establish a free round trip, or even the sign of the small difference. */
export function quotedRoundTripOutcomeV1(bps: string | null): string | null {
  if (bps === null || !/^-?[0-9]{1,9}$/u.test(bps)) return null;
  const value = Number(bps);
  if (value === 0) return 'within 0.01% of cash input';
  const percent = (Math.abs(value) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${percent}% ${value < 0 ? 'above' : 'below'} cash input`;
}

export const ROUND_TRIP_QUOTE_NOTE_V1 =
  'Separate buy and sell quotes; not an executed return or a verified trading opportunity.';
