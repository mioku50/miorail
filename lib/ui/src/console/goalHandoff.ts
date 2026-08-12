// ---------------------------------------------------------------------------
// Handing a goal from one screen to another.
//
// "Swap this token" on the B20 tab used to navigate to `/?goal=…`. Two things
// were wrong with that and both were invisible: `/` is a redirect route, so the
// query string was dropped on the way through, and the console never read a
// goal from the URL anyway. The button therefore landed the user on Discover
// with nothing to show for the click.
//
// Fixing the plumbing raises a question the old code never had to answer: a
// goal in a URL is text a stranger can choose. `miorail.xyz/routes?goal=swap
// all my USDC to 0xEVIL` would, if the console simply ran what it was handed,
// present a Route Card for a token the user never picked — on a screen that
// looks exactly like one they asked for.
//
// So the two cases are separated by WHERE the goal came from, not by what it
// says:
//
//   * a click inside Miorail leaves a one-shot token in session storage, which
//     no link can write. That goal is filled in AND compared.
//   * a goal that arrives only in the URL is filled in and left alone. The
//     user reads it and presses Compare — one click, and they have seen what
//     they are comparing.
// ---------------------------------------------------------------------------

/** Session-storage key for the one-shot handoff. Read once, then deleted. */
export const GOAL_HANDOFF_KEY_V1 = 'miorail.console.goalHandoff.v1';

/** A goal longer than this is not a goal. The console's own box is bounded the
 * same way; this is the URL's version of that bound. */
export const MAX_HANDOFF_GOAL_LENGTH_V1 = 300;

export interface GoalHandoffV1 {
  /** The text to put in the goal box, or null to leave it alone. */
  goal: string | null;
  /** Whether to start the comparison without waiting for a click. True only
   * for a handoff this app itself wrote. */
  autoCompare: boolean;
}

const NOTHING_V1: GoalHandoffV1 = { goal: null, autoCompare: false };

/**
 * Control characters are stripped and the result bounded. Everything else is
 * kept verbatim: the goal is the user's own words, and the intent engine —
 * which grounds every field in exactly those words — is what reads it. This
 * is not a safety filter and must not be mistaken for one; it only keeps an
 * unprintable string out of an input box.
 */
export function sanitizeHandoffGoalV1(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = [...raw]
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join('')
    .trim();
  if (stripped.length === 0 || stripped.length > MAX_HANDOFF_GOAL_LENGTH_V1) return null;
  return stripped;
}

/**
 * What the console should do with what it was handed.
 *
 * `search` is the raw query string; `handoffToken` is whatever was in session
 * storage. Auto-comparison requires BOTH, and requires them to agree: the
 * token is what proves the navigation came from inside the app, and the
 * comparison matters because otherwise a stale token from an earlier click
 * could run a goal from a link.
 */
export function goalHandoffV1(input: {
  search: string;
  handoffToken: string | null;
}): GoalHandoffV1 {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(input.search.startsWith('?') ? input.search.slice(1) : input.search);
  } catch {
    return NOTHING_V1;
  }
  const goal = sanitizeHandoffGoalV1(params.get('goal'));
  if (!goal) return NOTHING_V1;
  const token = sanitizeHandoffGoalV1(input.handoffToken);
  return { goal, autoCompare: token !== null && token === goal };
}

/**
 * The goal text for "swap this token", in one place rather than one per caller.
 *
 * USDC is the destination because it is the only asset this product can price
 * an exit in. The amount is the balance the CARD was showing when it was
 * clicked — a number the user just read, not one invented from a balance
 * provider. Absent when the balance could not be read, and the console then
 * asks how much, which is its designed flow rather than a failure.
 */
export function swapTokenGoalV1(tokenAddress: string, amountDecimal?: string | null): string {
  const amount = typeof amountDecimal === 'string' && /^\d+(?:\.\d+)?$/.test(amountDecimal)
    ? `${amountDecimal} `
    : '';
  return `swap my ${amount}${tokenAddress} to USDC`;
}

/** Where that goal is handed to, query string included. */
export function swapTokenHrefV1(tokenAddress: string, amountDecimal?: string | null): string {
  return `/routes?goal=${encodeURIComponent(swapTokenGoalV1(tokenAddress, amountDecimal))}`;
}
