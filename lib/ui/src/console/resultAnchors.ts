// ---------------------------------------------------------------------------
// Taking the user to the answer.
//
// The B20 tab puts its controls and its answers in different places. "Check
// now" sits at the bottom of the page and fills in the portfolio panel at the
// very top; "Can I get out?" sits on a holding card and answers in the exit
// card below it. Both worked. Both read as doing nothing, because a user who
// presses a button looks where the button is.
//
// The ids are here, next to the rule that uses them, so an anchor cannot be
// renamed in one file and scrolled to in another.
// ---------------------------------------------------------------------------

export const B20_PORTFOLIO_ANCHOR_V1 = 'b20-portfolio-panel';
export const B20_EXIT_ANCHOR_V1 = 'b20-exit-card';

export type ResultAnchorV1 = typeof B20_PORTFOLIO_ANCHOR_V1 | typeof B20_EXIT_ANCHOR_V1;

export interface ResultRevealStateV1 {
  /** True while the request that fills this panel is still running. */
  pending: boolean;
  /** True once that request has produced something to look at. */
  settled: boolean;
}

/**
 * Whether to move the user to a panel now.
 *
 * The rule is deliberately narrow: reveal on the EDGE from pending to settled,
 * and only when the user asked for it in this session. A panel that scrolls
 * itself into view on load would fight anyone who is reading something else,
 * and a page that jumps whenever data arrives is worse than one that never
 * moves — background refreshes are not answers to a question.
 */
export function shouldRevealResultV1(input: {
  previous: ResultRevealStateV1 | null;
  current: ResultRevealStateV1;
  /** False before the user has pressed anything in this session. */
  requested: boolean;
}): boolean {
  if (!input.requested) return false;
  if (!input.current.settled || input.current.pending) return false;
  // No previous state means this is the first render carrying a result — data
  // that was already there when the page opened, not an answer to a press.
  if (!input.previous) return false;
  return input.previous.pending;
}
