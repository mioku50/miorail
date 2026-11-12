import {
  RETRYABLE_REASONS_V1,
  anchorThroughFirstAnsweringV1,
  isEndpointFailureV1,
  type B20AnchoredReaderV1,
  type B20ReaderV1,
  type B20RpcReasonV1,
} from '@mioagent/b20-control';

// ---------------------------------------------------------------------------
// A pass's block anchor, asked for patiently.
//
// Every read of one pass is pinned to one block, so a pass that gets no anchor
// reads nothing. The supply and ratio pass asked one endpoint once, said "no
// block anchor (rate_limited) — nothing read, nothing stored" and exited 0. It
// runs every few hours and supply is trusted for seven, so on 2026-11-12 one
// throttled answer at 02:52 UTC left every Coinbase stock without a price on
// the board from 04:51 until the next pass, and no unit had failed: the alerts
// had nothing to say. The pools pass had met the same thing on 2026-10-25.
//
// So the anchor is asked of every configured endpoint in turn, the whole round
// again after a wait, and a pass that still has none says so with an exit code.
// ---------------------------------------------------------------------------

/** How many times every endpoint is asked. */
export const BLOCK_ANCHOR_ROUNDS_V1 = 3;
/** How long a pass waits between rounds: a throttle of this kind clears in seconds. */
export const BLOCK_ANCHOR_WAIT_MS_V1 = 30_000;
/** What a pass exits with when it was throttled out of its anchor. The service
 * alerts say this code in words (scripts/opsUnitAlerts.ts), as for a pass
 * throttled out of its quotes. */
export const BLOCK_ANCHOR_THROTTLED_EXIT_V1 = 75;

export type PatientAnchorV1<R> = B20AnchoredReaderV1<R> & {
  /** How many rounds were asked, the answering one included. */
  rounds: number;
};

/**
 * The first endpoint, in the order given, that answers a block anchor, asking
 * the whole list again after a wait when none does.
 *
 * Only an endpoint's own failure (a throttle, a timeout, no answer) is waited
 * out. Any other refusal is an answer about the chain, and asking again would
 * not change it.
 */
export async function anchorPatientlyV1<R extends Pick<B20ReaderV1, 'readBlockAnchor'>>(
  readers: readonly R[],
  options: { rounds?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PatientAnchorV1<R>> {
  const rounds = Math.max(1, options.rounds ?? BLOCK_ANCHOR_ROUNDS_V1);
  const waitMs = options.waitMs ?? BLOCK_ANCHOR_WAIT_MS_V1;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const refusals: B20RpcReasonV1[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const anchored = await anchorThroughFirstAnsweringV1(readers);
    if (anchored.ok) return { ...anchored, refusals: [...refusals, ...anchored.refusals], rounds: round };
    refusals.push(...anchored.refusals);
    // Asked of every endpoint and each one failed as an endpoint: worth a wait. Anything else is final.
    const worthWaiting = anchored.refusals.length >= readers.length && anchored.refusals.every(isEndpointFailureV1);
    if (!worthWaiting || round === rounds) return { ok: false, refusals, rounds: round };
    await sleep(waitMs);
  }
  return { ok: false, refusals, rounds };
}

/** The exit code of a pass that got no anchor: 75 when every refusal was a throttle or a timeout, 1 otherwise. */
export function blockAnchorExitCodeV1(refusals: readonly B20RpcReasonV1[]): number {
  return refusals.length > 0 && refusals.every((reason) => RETRYABLE_REASONS_V1.includes(reason)) ? BLOCK_ANCHOR_THROTTLED_EXIT_V1 : 1;
}

/** The endpoints a pass may ask, each once, in the order named. */
export function rpcEndpointsV1(urls: readonly (string | undefined)[]): string[] {
  return [...new Set(urls.map((url) => (url ?? '').trim()).filter((url) => url.length > 0))];
}
