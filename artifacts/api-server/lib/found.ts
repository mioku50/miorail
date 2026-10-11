import type { AerodromeRewardAlertRepositoryV1 } from '@mioagent/route-storage';

import {
  aboutDollarsV1,
  aerodromeRewardsNextV1,
  aerodromeRewardsReplyV1,
  readAerodromeRewardsV1,
  usdcAtomicToCentsV1,
  type AerodromeRewardsReadV1,
} from './aerodromeRewards.js';
import { centsV1, russianV1 } from './aerodromeRewardIntents.js';
import type { BaseMcpConsoleNextV1, BaseMcpConsoleResultV1 } from './baseMcpConsole.js';
import {
  FOUND_ALERT_PROMPT_V1,
  readUniswapFeesV1,
  uniswapFeesNextV1,
  uniswapFeesReplyV1,
  type UniswapFeesReadV1,
} from './uniswapFees.js';

// ---------------------------------------------------------------------------
// Found, inside Wallet MCP: what a wallet can claim now on Aerodrome and
// collect on Uniswap, read by Miorail from Base, and one alert when the two
// together build up.
//
// Measured before it was built (2026-10-11): of 800 Farcaster accounts, 3-5%
// had $1 to claim across their wallets. A tool for people who provide
// liquidity, kept beside the claim, not a door for everyone. The operator
// could not find it the same day, so "What can I claim?" now asks both.
// ---------------------------------------------------------------------------

export type FoundProtocolV1 = 'aerodrome' | 'uniswap';

/** How often the notifier reads a wallet that asked for an alert. */
export const FOUND_READ_EVERY_MS_V1 = 6 * 3_600_000;
/** A reading that failed is tried again after this. */
export const FOUND_RETRY_AFTER_MS_V1 = 30 * 60_000;
/** A reading older than this is not told: the rewards may be gone. */
export const FOUND_FRESH_FOR_MS_V1 = 12 * 3_600_000;
/** Readings per notifier pass: Aerodrome's walks every pool, 20-45 s. */
export const FOUND_READS_PER_PASS_V1 = 2;

export const foundRuntimeV1 = {
  readAerodrome: readAerodromeRewardsV1,
  readUniswap: readUniswapFeesV1,
};

/** The combined answer: a total, then each protocol's own reading without
 * its "Say …" line, since the buttons under the answer carry those. */
export function foundReplyV1(
  aerodrome: AerodromeRewardsReadV1,
  uniswap: UniswapFeesReadV1,
  russian: boolean,
): { reply: string; errorCode: string | null } {
  const a = aerodromeRewardsReplyV1(aerodrome, russian, { say: false });
  const u = uniswapFeesReplyV1(uniswap, russian, { say: false });
  const found = (aerodrome.ok && aerodrome.rewards.claims > 0) || (uniswap.ok && uniswap.fees.positions.length > 0);
  const total = (aerodrome.ok ? BigInt(aerodrome.rewards.totalUsdcAtomic) : 0n) + (uniswap.ok ? BigInt(uniswap.fees.totalUsdcAtomic) : 0n);
  const failed = !aerodrome.ok || !uniswap.ok;
  const head = found
    ? total > 0n
      ? russian
        ? `Можно забрать ${aboutDollarsV1(total.toString(), russian)}${failed ? ' — в том, что удалось прочитать' : ''}.`
        : `You can claim ${aboutDollarsV1(total.toString(), russian)} now${failed ? ', in what could be read' : ''}.`
      : russian ? 'Найдены награды, которые сейчас не оценил ни один роутер.' : 'Found rewards no router could price right now.'
    : failed
      ? russian ? 'Прочитано не всё, поэтому это не «забирать нечего».' : 'Not everything could be read, so this is not “nothing to claim”.'
      : russian ? 'Сейчас забирать нечего ни на Aerodrome, ни на Uniswap.' : 'Nothing to claim on Aerodrome or Uniswap right now.';
  return {
    reply: [head, '', a.reply, '', u.reply].join('\n'),
    // The answer stands when one side was read: it names what was not.
    errorCode: !aerodrome.ok && !uniswap.ok ? a.errorCode : null,
  };
}

/** The buttons under a combined answer: each protocol's claim where it found
 * something, then one alert for both. */
export function foundNextV1(
  aerodrome: AerodromeRewardsReadV1,
  uniswap: UniswapFeesReadV1,
  input: { russian: boolean; aerodromeClaimReleased: boolean; uniswapCollectReleased: boolean },
): BaseMcpConsoleNextV1[] {
  const claims = [
    ...aerodromeRewardsNextV1(aerodrome, { russian: input.russian, claimReleased: input.aerodromeClaimReleased }),
    ...uniswapFeesNextV1(uniswap, { russian: input.russian, collectReleased: input.uniswapCollectReleased }),
  ].filter((next) => next.kind === 'claim');
  const anyRead = aerodrome.ok || uniswap.ok;
  return anyRead ? [...claims, { prompt: FOUND_ALERT_PROMPT_V1[input.russian ? 'ru' : 'en'], kind: 'alert' }] : claims;
}

/** Found's reading in the console, for one protocol or both. Nothing is
 * asked of Wallet MCP or any provider, and nothing is prepared. */
export async function runFoundReadV1(input: {
  walletAddress: string;
  message: string;
  protocols: readonly FoundProtocolV1[];
  aerodromeClaimReleased: boolean;
  uniswapCollectReleased: boolean;
  now?: () => Date;
}): Promise<BaseMcpConsoleResultV1> {
  const startedAt = Date.now();
  const wallet = input.walletAddress.toLowerCase();
  const russian = russianV1(input.message);
  const wants = (protocol: FoundProtocolV1) => input.protocols.includes(protocol);
  const [aerodrome, uniswap] = await Promise.all([
    wants('aerodrome') ? foundRuntimeV1.readAerodrome(wallet) : Promise.resolve(null),
    wants('uniswap') ? foundRuntimeV1.readUniswap(wallet) : Promise.resolve(null),
  ]);
  const answer = aerodrome && uniswap ? foundReplyV1(aerodrome, uniswap, russian)
    : aerodrome ? aerodromeRewardsReplyV1(aerodrome, russian)
      : uniswapFeesReplyV1(uniswap!, russian);
  const next = aerodrome && uniswap
    ? foundNextV1(aerodrome, uniswap, { russian, aerodromeClaimReleased: input.aerodromeClaimReleased, uniswapCollectReleased: input.uniswapCollectReleased })
    : aerodrome ? aerodromeRewardsNextV1(aerodrome, { russian, claimReleased: input.aerodromeClaimReleased })
      : uniswapFeesNextV1(uniswap!, { russian, collectReleased: input.uniswapCollectReleased });
  const args = (protocol: string) => JSON.stringify({ chain: 'base', wallet, protocol });
  const trace = [
    ...(aerodrome ? [{ tool: 'aerodrome_rewards_read', args: args('aerodrome'), ok: aerodrome.ok,
      result: JSON.stringify(aerodrome).slice(0, 4_000), errorCode: aerodrome.ok ? null : aerodrome.errorCode }] : []),
    ...(uniswap ? [{ tool: 'uniswap_fees_read', args: args('uniswap-v3'), ok: uniswap.ok,
      result: JSON.stringify(uniswap).slice(0, 4_000), errorCode: uniswap.ok ? null : uniswap.errorCode }] : []),
  ];
  return {
    status: answer.errorCode ? 'failed' : 'answered', reply: answer.reply, trace,
    toolsAvailable: trace.length, truncated: false, elapsedMs: Date.now() - startedAt, errorCode: answer.errorCode,
    checkedAt: (input.now?.() ?? new Date()).toISOString(), next,
  };
}

/** What the alert reads: everything Found can claim for the wallet, in USDC
 * atoms. Both sides must be read, or the reading is a failure retried later. */
export type FoundTotalReadV1 =
  | { ok: true; blockNumber: string; totalUsdcAtomic: string }
  | { ok: false; errorCode: string };

export async function readFoundTotalV1(walletAddress: string): Promise<FoundTotalReadV1> {
  const [aerodrome, uniswap] = await Promise.all([
    foundRuntimeV1.readAerodrome(walletAddress), foundRuntimeV1.readUniswap(walletAddress),
  ]);
  if (!aerodrome.ok) return { ok: false, errorCode: aerodrome.errorCode };
  if (!uniswap.ok) return { ok: false, errorCode: uniswap.errorCode };
  const blocks = [BigInt(aerodrome.rewards.blockNumber), BigInt(uniswap.fees.blockNumber)];
  return {
    ok: true,
    blockNumber: (blocks[0]! < blocks[1]! ? blocks[0]! : blocks[1]!).toString(),
    totalUsdcAtomic: (BigInt(aerodrome.rewards.totalUsdcAtomic) + BigInt(uniswap.fees.totalUsdcAtomic)).toString(),
  };
}

/** The push: Base App takes a title of 30 characters and a message of 200. */
export function foundRewardNoticeV1(input: { usdCents: number }): { title: string; message: string; targetPath: string } {
  const amount = centsV1(input.usdCents);
  return {
    title: `Rewards to claim: ${amount}`.slice(0, 30),
    message: `This wallet can claim about ${amount} in fees and rewards on Aerodrome and Uniswap. Open Wallet MCP in Miorail and ask “What can I claim?”.`,
    targetPath: '/extensions',
  };
}

/** The notifier's reading pass: the wallets due, read and kept. A dry pass
 * reads and keeps nothing. */
export async function refreshFoundAlertsV1(input: {
  alerts: AerodromeRewardAlertRepositoryV1;
  now: Date;
  dry?: boolean;
  limit?: number;
  read?: (walletAddress: string) => Promise<FoundTotalReadV1>;
}): Promise<{ due: number; read: number; failed: number }> {
  const read = input.read ?? readFoundTotalV1;
  const due = await input.alerts.dueForRead({
    readBefore: new Date(input.now.getTime() - FOUND_READ_EVERY_MS_V1),
    retryBefore: new Date(input.now.getTime() - FOUND_RETRY_AFTER_MS_V1),
    limit: input.limit ?? FOUND_READS_PER_PASS_V1,
  });
  const report = { due: due.length, read: 0, failed: 0 };
  for (const walletAddress of due) {
    const reading = await read(walletAddress).catch((): FoundTotalReadV1 => ({ ok: false, errorCode: 'found_read_unavailable' }));
    if (reading.ok) report.read += 1;
    else report.failed += 1;
    if (input.dry) continue;
    await input.alerts.recordRead({
      walletAddress,
      at: input.now,
      block: reading.ok ? reading.blockNumber : null,
      usdCents: reading.ok ? usdcAtomicToCentsV1(reading.totalUsdcAtomic) : null,
      error: reading.ok ? null : reading.errorCode,
    });
  }
  return report;
}
