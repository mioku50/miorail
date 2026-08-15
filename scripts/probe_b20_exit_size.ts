import {
  resolveB20PoolV1,
  quoteV4ExactInputV1,
} from '@mioagent/swap-adapters';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// Read-only diagnostic. Separates two things that `no_exit_route` cannot tell
// apart on its own — the stored latest verdict on 2,519 B20 launches:
//
//   a) the pool will not price a sale of THIS size, or
//   b) the pool will not price a sale of ANY size.
//
// It matters because `b20RoundTripV4V1` quotes the exit once, at the full
// entry output, and returns early when that reverts — the capacity ladder that
// would find a workable size never runs. So (a) and (b) are stored
// identically.
//
// Run 2026-08-15 against a live control (BILLIONS, whose exit the worker had
// just priced) it answered (b): WHAL priced an entry and reverted every exit
// down to 1/100,000 of the position. The cause is not size and not venue
// coverage — it is that 1,769 of those launches have never had a single buyer,
// so their pool holds no quote asset to sell into. The remaining ~190, bought
// and still unsellable, are the set worth inspecting with this.
//
// USE A CONTROL. The first version of this script read the pool resolver's
// result shape wrongly and sent the quoter `key: undefined`, so EVERY token
// came back `empty_result` — indistinguishable from "this token cannot be
// sold". A token the worker had just measured successfully is what exposed it.
//
// Signs nothing, sends nothing, prints no endpoint.

const RPC_V1 = process.env.BASE_MAINNET_RPC_URL ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
const FRACTIONS_V1 = [1, 2, 4, 10, 100, 1_000, 10_000, 100_000] as const;

interface TargetV1 {
  symbol: string;
  token: string;
  launchBlock: number;
  positionAtomic: string;
}

async function rpcV1(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC_V1, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'miorail-diagnostic/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`rpc ${method} http ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? 'error'}`);
  return body.result;
}

const getLogsV1 = async (request: {
  address: string;
  fromBlock: number;
  toBlock: number;
  topics: (string | null)[];
}) =>
  (await rpcV1('eth_getLogs', [
    {
      address: request.address,
      fromBlock: `0x${request.fromBlock.toString(16)}`,
      toBlock: `0x${request.toBlock.toString(16)}`,
      topics: request.topics,
    },
  ])) as readonly { address?: string; topics?: readonly string[]; data?: string }[];

/**
 * An eth_call that returns '' on revert, which is how the quoter reads
 * "no liquidity at this size" as an answer rather than an outage.
 *
 * A revert and an outage MUST NOT look the same here — conflating them is how
 * a dead endpoint gets reported as a property of a token. The first distinct
 * failure of each kind is printed once so the run can be read honestly.
 */
const seenV1 = new Set<string>();
const callV1 = async (request: { to: string; data: string }): Promise<string> => {
  try {
    return (await rpcV1('eth_call', [{ to: request.to, data: request.data }, 'latest'])) as string;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reverted = /revert|execution reverted|out of gas/i.test(message);
    const key = `${reverted ? 'revert' : 'transport'}:${message.slice(0, 90)}`;
    if (!seenV1.has(key)) {
      seenV1.add(key);
      console.log(`   [${reverted ? 'REVERT' : 'TRANSPORT'}] ${message.slice(0, 160)}`);
    }
    if (!reverted) throw error;
    return '';
  }
};

async function probeV1(target: TargetV1): Promise<void> {
  const resolved = await resolveB20PoolV1({
    token: target.token,
    launchBlock: target.launchBlock,
    getLogs: getLogsV1,
  });
  if (!resolved.ok) {
    console.log(`${target.symbol.padEnd(8)} pool: ${resolved.refusal}`);
    return;
  }
  const pool = resolved.pool;

  const entryZeroForOne = !pool.tokenIsCurrency0;
  if (process.env.B20_PROBE_DEBUG === '1') {
    console.log(`   key=${JSON.stringify(pool.key)} tokenIsCurrency0=${pool.tokenIsCurrency0}`);
  }
  const entry = await quoteV4ExactInputV1({
    key: pool.key,
    zeroForOne: entryZeroForOne,
    exactAmountAtomic: BigInt(target.positionAtomic),
    call: async (request) => {
      const value = await callV1(request);
      if (process.env.B20_PROBE_DEBUG === '1') {
        console.log(`   to=${request.to} dataLen=${request.data.length} → ${value === '' ? '<empty>' : `${value.slice(0, 74)}…`}`);
      }
      return value;
    },
  });
  if (!entry.ok) {
    console.log(`${target.symbol.padEnd(8)} entry: ${entry.refusal}`);
    return;
  }

  const acquired = BigInt(entry.amountOutAtomic);
  const results: string[] = [];
  let largestPricing: bigint | null = null;
  for (const divisor of FRACTIONS_V1) {
    const size = acquired / BigInt(divisor);
    if (size === 0n) continue;
    const exit = await quoteV4ExactInputV1({
      key: pool.key,
      zeroForOne: !entryZeroForOne,
      exactAmountAtomic: size,
      call: callV1,
    });
    const label = divisor === 1 ? 'full' : `1/${divisor}`;
    if (exit.ok) {
      if (largestPricing === null) largestPricing = size;
      const returned = BigInt(exit.amountOutAtomic);
      const share = (returned * 10_000n) / (BigInt(target.positionAtomic) / BigInt(divisor));
      results.push(`${label}=ok(${Number(share) / 100}% back)`);
    } else {
      results.push(`${label}=${exit.refusal}`);
    }
  }
  console.log(`${target.symbol.padEnd(8)} entry ok → ${results.join('  ')}`);
}

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const targets: TargetV1[] = [];
  for (const argument of process.argv.slice(2)) {
    const [symbol, token, block, position] = argument.split(',');
    if (!symbol || !token || !block || !position) continue;
    targets.push({ symbol, token, launchBlock: Number(block), positionAtomic: position });
  }
  if (targets.length === 0) {
    console.error('Pass targets as symbol,token,launchBlock,positionAtomic');
    process.exitCode = 1;
    return;
  }
  for (const target of targets) {
    try {
      await probeV1(target);
    } catch (error) {
      console.log(`${target.symbol}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }
}

void main();
