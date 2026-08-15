import {
  B20_POOL_SEARCH_BLOCKS_V1,
  UNISWAP_V4_INITIALIZE_TOPIC_V1,
  UNISWAP_V4_POOL_MANAGER_V1,
  b20PoolFromInitializeLogV1,
} from '@mioagent/swap-adapters';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Read-only diagnostic: HOW FAR past a launch is its pool actually created?
//
// `resolveB20PoolV1` searches exactly ten blocks from the launch block, and
// `windows` is never passed by any caller. Ten was chosen for two reasons,
// both worth re-checking rather than inheriting:
//
//   * both tokens sampled when the resolver was written had their pool
//     initialised in the same ten-block span (+0..+9);
//   * the production RPC plan then in use capped eth_getLogs at ten blocks.
//
// The second reason is gone — production now reads mainnet.base.org, which
// serves a ten-thousand-block getLogs in one call. Whether the first still
// holds is what this measures, over launches whose latest observation says
// Miorail found no venue at all.
//
// USE A CONTROL. A run where nothing is found is indistinguishable from a run
// where the probe is broken; the previous diagnostic in this directory read a
// result shape wrongly and reported every token as unpriceable. Tokens the
// worker HAS resolved are included and must come back found at a small offset.
//
// Signs nothing, sends nothing, prints no endpoint.
// ---------------------------------------------------------------------------

const RPC_V1 = process.env.BASE_MAINNET_RPC_URL ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
/** How far past the launch to look. One request per side at base.org. */
const WIDE_BLOCKS_V1 = Number.parseInt(process.env.B20_PROBE_WINDOW ?? '10000', 10);

interface TargetV1 {
  bucket: string;
  token: string;
  symbol: string;
  launchBlock: number;
}

async function rpcV1(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC_V1, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'miorail-diagnostic/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`http ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'rpc error');
  return body.result;
}

type LogV1 = { address?: string; topics?: readonly string[]; data?: string; blockNumber?: string };

async function initializeLogsV1(token: string, fromBlock: number, toBlock: number): Promise<LogV1[]> {
  const tokenTopic = `0x000000000000000000000000${token.slice(2)}`;
  const found: LogV1[] = [];
  // Two queries, because v4 orders currencies by address and the B20 token may
  // be either side of the pair.
  for (const topics of [
    [UNISWAP_V4_INITIALIZE_TOPIC_V1, null, null, tokenTopic],
    [UNISWAP_V4_INITIALIZE_TOPIC_V1, null, tokenTopic, null],
  ]) {
    const logs = (await rpcV1('eth_getLogs', [
      {
        address: UNISWAP_V4_POOL_MANAGER_V1,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        topics,
      },
    ])) as LogV1[];
    found.push(...logs);
  }
  return found;
}

async function headBlockV1(): Promise<number> {
  return Number(BigInt((await rpcV1('eth_blockNumber', [])) as string));
}

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const targets: TargetV1[] = [];
  for (const line of process.argv.slice(2)) {
    const [bucket, token, symbol, block] = line.split('|');
    if (!token || !block) continue;
    targets.push({ bucket: bucket ?? '?', token: token.toLowerCase(), symbol: symbol ?? token, launchBlock: Number(block) });
  }
  if (targets.length === 0) {
    console.log('usage: pnpm b20:probe-pool-window "bucket|0xtoken|SYMBOL|launchBlock" ...');
    return;
  }

  // Clamped, because a launch nearer the head than the probe window makes the
  // endpoint refuse the whole request — which would be counted as "no pool"
  // and is nothing of the kind.
  const head = await headBlockV1();
  console.log(`window: launch+0 .. launch+${WIDE_BLOCKS_V1} (clamped to head ${head})   current search: ${B20_POOL_SEARCH_BLOCKS_V1} blocks\n`);
  const offsets: number[] = [];
  const perBucket = new Map<
    string,
    { found: number; withinTen: number; total: number; unreadable: number; refusedPools: number }
  >();
  /** Why a pool that EXISTS was not usable. The difference between "this token
   * has no venue" and "Miorail will not read this venue" is the whole point. */
  const refusals = new Map<string, number>();

  for (const target of targets) {
    const tally = perBucket.get(target.bucket)
      ?? { found: 0, withinTen: 0, total: 0, unreadable: 0, refusedPools: 0 };
    tally.total += 1;
    const toBlock = Math.min(target.launchBlock + WIDE_BLOCKS_V1, head);
    let logs: LogV1[];
    try {
      logs = await initializeLogsV1(target.token, target.launchBlock, toBlock);
    } catch (error) {
      // An unanswered endpoint is NOT "this token has no pool". Counted apart.
      tally.unreadable += 1;
      perBucket.set(target.bucket, tally);
      console.log(`${target.bucket} ${target.symbol.padEnd(16)} endpoint: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    let best: { offset: number; quote: string } | null = null;
    let refusedHere: string | null = null;
    for (const log of logs) {
      const decoded = b20PoolFromInitializeLogV1(log, target.token);
      if (!decoded.ok) {
        // Name the pair it WAS quoted against. "unsupported_quote_asset" is a
        // product boundary, not a missing venue, and the two must not be
        // reported as the same thing.
        const other = [log.topics?.[2], log.topics?.[3]]
          .map((topic) => (topic ? `0x${topic.slice(26)}`.toLowerCase() : ''))
          .find((address) => address !== '' && address !== target.token);
        const label = decoded.refusal === 'unsupported_quote_asset' ? `${decoded.refusal}:${other ?? '?'}` : decoded.refusal;
        refusals.set(label, (refusals.get(label) ?? 0) + 1);
        refusedHere = label;
        continue;
      }
      const offset = Number(BigInt(log.blockNumber ?? '0x0')) - target.launchBlock;
      if (!best || offset < best.offset) best = { offset, quote: decoded.pool.quoteAsset };
    }

    if (!best) {
      if (refusedHere) tally.refusedPools += 1;
      perBucket.set(target.bucket, tally);
      const searched = toBlock - target.launchBlock;
      console.log(
        `${target.bucket} ${target.symbol.padEnd(16)} ${
          refusedHere
            ? `pool exists but REFUSED: ${refusedHere}`
            : `no Initialize log in ${searched} blocks`
        }`,
      );
      continue;
    }
    tally.found += 1;
    if (best.offset < B20_POOL_SEARCH_BLOCKS_V1) tally.withinTen += 1;
    offsets.push(best.offset);
    perBucket.set(target.bucket, tally);
    const quote = best.quote === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'USDC';
    const reach = best.offset < B20_POOL_SEARCH_BLOCKS_V1 ? 'inside today’s window' : 'MISSED by today’s window';
    console.log(`${target.bucket} ${target.symbol.padEnd(16)} +${String(best.offset).padStart(6)} blocks  ${quote.padEnd(4)}  ${reach}`);
  }

  console.log('');
  for (const [bucket, tally] of [...perBucket].sort()) {
    console.log(
      `${bucket}: ${tally.found}/${tally.total} have a readable pool, ${tally.withinTen} of them inside the current ${B20_POOL_SEARCH_BLOCKS_V1}-block search` +
        (tally.refusedPools > 0 ? `, ${tally.refusedPools} had a pool Miorail refused` : '') +
        (tally.unreadable > 0 ? `, ${tally.unreadable} unreadable (endpoint, not token)` : ''),
    );
  }
  if (refusals.size > 0) {
    console.log(`refusals on real logs: ${[...refusals].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (offsets.length > 0) {
    const sorted = [...offsets].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    console.log(
      `offsets: min ${sorted[0]}  p50 ${at(0.5)}  p90 ${at(0.9)}  p99 ${at(0.99)}  max ${sorted[sorted.length - 1]}`,
    );
  }
}

void main();
