// ---------------------------------------------------------------------------
// When a reviewed source stops being readable, nothing breaks.
//
// That is deliberate. A source that times out withdraws nothing, because an
// asset does not stop being officially issued because our request did. The
// price of that design is silence: `base_docs_technical` went unparsable on
// 2026-09-10, when Base moved the document and renamed one heading. Eight
// consecutive passes read the page, refused it, stored the refusal, printed it
// to a log nobody reads, exited zero, and left the timer green.
//
// This is the rule that turns that silence into a failed unit:
//
//   unparsable   the document WAS read and is no longer understood. A shape
//                change does not heal itself, so it counts at once.
//   unreachable  usually a blip, and blips recover. It counts only once the
//                source has gone a whole day with no successful read.
//
// It fails the PASS, never the membership: nothing is withdrawn, no signal is
// emitted, no stored row moves. The only thing that changes is that somebody
// can see it.
// ---------------------------------------------------------------------------

export interface OfficialSourceCheckV1 {
  sourceKind: string;
  /** Structural on purpose: the status vocabulary is the store's, and one
   * exported name for it, in one package, stays one name. */
  status: 'ok' | 'unreachable' | 'unparsable';
  detail: string | null;
  /** When this source last parsed, from the stored snapshots. Null if never. */
  lastSuccessAt: string | null;
}

/** A source unreachable for longer than this has stopped being a blip. */
export const OFFICIAL_SOURCE_DARK_AFTER_MS_V1 = 24 * 60 * 60 * 1000;

function darkForV1(lastSuccessAt: string | null, nowMs: number): string {
  if (lastSuccessAt === null) return 'never read successfully';
  const hours = Math.floor((nowMs - Date.parse(lastSuccessAt)) / 3_600_000);
  return `last read ${hours}h ago, ${lastSuccessAt}`;
}

/**
 * The sources whose failure this pass should be reported as the worker's own
 * failure, one line each. Empty means every reviewed source answered.
 */
export function officialSourceRegressionsV1(input: {
  checks: readonly OfficialSourceCheckV1[];
  now: string;
  darkAfterMs?: number;
}): string[] {
  const nowMs = Date.parse(input.now);
  const darkAfterMs = input.darkAfterMs ?? OFFICIAL_SOURCE_DARK_AFTER_MS_V1;
  const lines: string[] = [];
  for (const check of input.checks) {
    if (check.status === 'ok') continue;
    if (check.status === 'unparsable') {
      lines.push(
        `${check.sourceKind}: read and not understood — ${check.detail ?? 'no detail'}`,
      );
      continue;
    }
    const lastMs = check.lastSuccessAt === null ? null : Date.parse(check.lastSuccessAt);
    if (lastMs !== null && nowMs - lastMs < darkAfterMs) continue;
    lines.push(`${check.sourceKind}: unreachable and dark — ${darkForV1(check.lastSuccessAt, nowMs)}`);
  }
  return lines;
}
