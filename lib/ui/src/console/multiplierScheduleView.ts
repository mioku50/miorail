// ---------------------------------------------------------------------------
// What one token converts with, and what is planned for it — kept apart.
//
// Cobalt lets an issuer publish a multiplier change dated ahead. The number in
// that announcement is real, published by the issuer, and WRONG for the only
// question a holder actually asks — how many underlying shares is one token
// right now — until its date arrives. It can also be withdrawn, or replaced.
//
// So this module renders two things that must never merge into one:
//
//   the EFFECTIVE multiplier, from the token's own reading, and
//   what is SCHEDULED, with its date and the fact that it is not in force.
//
// A screen that showed the scheduled value under the heading "multiplier" would
// state a future as a fact about the present, on the number that says how many
// real shares somebody owns. That is [[announced-is-not-live]] on the worst
// possible field.
// ---------------------------------------------------------------------------

export interface MultiplierChangeWireV1 {
  state?: string | null;
  cause?: string | null;
  route?: string | null;
  multiplierWad?: string | null;
  effectiveAt?: string | null;
  announcedAt?: string | null;
}

export interface MultiplierStandingWireV1 {
  effectiveMultiplierWad?: string | null;
  effectiveAsOf?: { blockNumber?: number | null; blockTime?: string | null } | null;
  scheduled?: readonly MultiplierChangeWireV1[];
  history?: readonly MultiplierChangeWireV1[];
}

export interface MultiplierScheduleLineV1 {
  text: string;
  tone: 'neutral' | 'warn' | 'off';
}

export interface MultiplierScheduleViewV1 {
  /** The one a holder converts with. Always first, always from a reading. */
  effective: MultiplierScheduleLineV1;
  /** Dated plans that are not in force. Empty is the ordinary case. */
  scheduled: readonly MultiplierScheduleLineV1[];
  /** Plans that did not happen, kept because a withdrawn plan is news too. */
  notExecuted: readonly MultiplierScheduleLineV1[];
}

/** `1.000377118676784179` from a WAD string. Decimal arithmetic, because a
 * float loses the digits that make a share count reconcile. */
export function multiplierDecimalV1(wad: string | null | undefined): string | null {
  if (typeof wad !== 'string' || !/^[0-9]+$/.test(wad)) return null;
  const padded = wad.padStart(19, '0');
  const whole = padded.slice(0, padded.length - 18);
  const fraction = padded.slice(padded.length - 18);
  return `${whole}.${fraction}`;
}

/** A decimal with its trailing zeros gone, for a sentence rather than a table.
 * `1.000000000000000000` is `1`, and `1` is the thing worth saying. */
function readableV1(wad: string | null | undefined): string | null {
  const decimal = multiplierDecimalV1(wad);
  if (decimal === null) return null;
  const trimmed = decimal.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed.length === 0 ? '0' : trimmed;
}

function dayV1(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string') return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function multiplierScheduleViewV1(
  wire: MultiplierStandingWireV1 | null | undefined,
): MultiplierScheduleViewV1 | null {
  if (!wire) return null;

  const effectiveValue = readableV1(wire.effectiveMultiplierWad);
  const effective: MultiplierScheduleLineV1 =
    effectiveValue === null
      ? {
          // Never filled in from a scheduled change. Nothing read is nothing
          // read, and the plan's number is not a substitute for a measurement.
          text: 'Miorail has not read how many shares one token currently represents.',
          tone: 'neutral',
        }
      : effectiveValue === '1'
        ? { text: 'One token represents one underlying share.', tone: 'neutral' }
        : { text: `One token represents ${effectiveValue} underlying shares.`, tone: 'neutral' };

  const scheduled = (wire.scheduled ?? []).flatMap((change): MultiplierScheduleLineV1[] => {
    const value = readableV1(change.multiplierWad);
    const date = dayV1(change.effectiveAt);
    if (value === null || date === null) return [];
    return [
      {
        // "From <date>" and "not yet" in the same sentence, because a reader
        // who takes only half of it takes the wrong half.
        text: `The issuer has scheduled a change to ${value} shares per token, from ${date}. It is not in force yet — until then one token converts at the figure above.`,
        tone: 'warn',
      },
    ];
  });

  const notExecuted = (wire.history ?? [])
    .filter((change) => change.state === 'not_executed_as_planned')
    .flatMap((change): MultiplierScheduleLineV1[] => {
      const value = readableV1(change.multiplierWad);
      const date = dayV1(change.effectiveAt);
      if (value === null) return [];
      const when = date === null ? '' : ` for ${date}`;
      return [
        {
          text:
            change.cause === 'cancelled'
              ? `A change to ${value} shares per token was scheduled${when} and the issuer withdrew it. It did not happen.`
              : `A change to ${value} shares per token was scheduled${when} and was replaced before it took effect. It did not happen.`,
          tone: 'neutral',
        },
      ];
    });

  // `awaiting_confirmation` is deliberately NOT rendered as either. It is a gap
  // in our reading rather than a fact about the asset, and the honest place for
  // it is the evidence panel, not a sentence about the instrument.
  return { effective, scheduled, notExecuted };
}
