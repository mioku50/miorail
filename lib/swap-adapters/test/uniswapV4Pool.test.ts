import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  b20PoolFromInitializeLogV1,
  resolveB20PoolV1,
  type RawLogV1,
} from '../src/uniswap-v4-pool.js';
import {
  UNISWAP_V4_INITIALIZE_TOPIC_V1,
  UNISWAP_V4_POOL_MANAGER_V1,
} from '../src/uniswap-v4-pinned.js';

// ---------------------------------------------------------------------------
// Built from the two pools read off Base mainnet on 2026-08-09, because a
// fixture invented from the spec is how the KyberSwap and Uniswap adapters
// stayed green for months against shapes their APIs had stopped serving.
//
//   PDRSTR  poolId 0x07fff5bc…  currency0 USDC, currency1 token
//   summer  poolId 0x2b69e73a…  currency0 native ETH, currency1 token
//
// Both: fee 0, tickSpacing 200, hooks 0x985c14ba… — the B20 launch hook, which
// is why the PoolKey cannot be guessed and has to be read.
// ---------------------------------------------------------------------------

const PDRSTR = '0xb200000000000000000000294511530ba9d34201';
const SUMMER = '0xb2000000000000000000005eeba810a2bcfdfc01';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NATIVE = '0x0000000000000000000000000000000000000000';
const HOOK = '0x985c14baa2a18316ffda0aefb3a632fadfca2acc';

const word = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
const topicFor = (address: string): string => `0x${word(address)}`;

/** fee, tickSpacing, hooks, sqrtPriceX96, tick — the five data words. */
function initializeData(fee: number, tickSpacing: number, hooks: string): string {
  return (
    '0x' +
    word(fee.toString(16)) +
    word((tickSpacing < 0 ? 0x1000000 + tickSpacing : tickSpacing).toString(16)) +
    word(hooks) +
    word('79228162514264337593543950336') +
    word('0')
  );
}

function initializeLog(overrides: Partial<RawLogV1> & { currency0: string; currency1: string }): RawLogV1 {
  const { currency0, currency1, ...rest } = overrides;
  return {
    address: UNISWAP_V4_POOL_MANAGER_V1,
    topics: [
      UNISWAP_V4_INITIALIZE_TOPIC_V1,
      `0x${'07'.repeat(32)}`,
      topicFor(currency0),
      topicFor(currency1),
    ],
    data: initializeData(0, 200, HOOK),
    blockNumber: '0x2f22f7a',
    ...rest,
  };
}

describe('a B20 token is resolved to the v4 pool that prices it', () => {
  test('PDRSTR: the token is currency1, quoted in USDC', () => {
    const result = b20PoolFromInitializeLogV1(
      initializeLog({ currency0: USDC, currency1: PDRSTR }),
      PDRSTR,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.pool.token, PDRSTR);
    assert.equal(result.pool.quoteAsset, USDC);
    assert.equal(result.pool.tokenIsCurrency0, false);
    assert.equal(result.pool.key.fee, 0);
    assert.equal(result.pool.key.tickSpacing, 200);
    assert.equal(result.pool.key.hooks, HOOK);
  });

  test('summer: the same shape quoted in native ETH', () => {
    const result = b20PoolFromInitializeLogV1(
      initializeLog({ currency0: NATIVE, currency1: SUMMER }),
      SUMMER,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.pool.quoteAsset, NATIVE);
    assert.equal(result.pool.tokenIsCurrency0, false);
  });

  test('the token being currency0 is read the other way round, not refused', () => {
    // v4 orders currencies by address, so neither side is guaranteed. A
    // resolver that assumed one position would silently lose half the pools.
    const result = b20PoolFromInitializeLogV1(
      initializeLog({ currency0: PDRSTR, currency1: USDC }),
      PDRSTR,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.pool.tokenIsCurrency0, true);
    assert.equal(result.pool.quoteAsset, USDC);
  });

  test('a negative tickSpacing decodes as a signed int24', () => {
    const log = initializeLog({ currency0: USDC, currency1: PDRSTR });
    log.data = initializeData(3000, -60, HOOK);
    const result = b20PoolFromInitializeLogV1(log, PDRSTR);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.pool.key.tickSpacing, -60);
    assert.equal(result.pool.key.fee, 3000);
  });
});

describe('what the resolver refuses, and why', () => {
  test('a log from anywhere but the singleton is not a pool', () => {
    // The signature is public; anyone can emit it. Only the PoolManager's
    // version means a pool exists.
    const log = initializeLog({ currency0: USDC, currency1: PDRSTR });
    log.address = '0x1111111111111111111111111111111111111111';
    assert.deepEqual(b20PoolFromInitializeLogV1(log, PDRSTR), { ok: false, refusal: 'wrong_emitter' });
  });

  test('a different event from the same contract is refused', () => {
    const log = initializeLog({ currency0: USDC, currency1: PDRSTR });
    log.topics = [`0x${'ab'.repeat(32)}`, ...(log.topics ?? []).slice(1)];
    assert.deepEqual(b20PoolFromInitializeLogV1(log, PDRSTR), { ok: false, refusal: 'wrong_event' });
  });

  test('a pool the token is not in is refused rather than measured', () => {
    const log = initializeLog({ currency0: USDC, currency1: SUMMER });
    assert.deepEqual(b20PoolFromInitializeLogV1(log, PDRSTR), { ok: false, refusal: 'token_not_in_pool' });
  });

  test('a pool quoted in another long-tail token is refused', () => {
    // An exit price denominated in something the holder must also exit from
    // is not an answer to "can I get out".
    const log = initializeLog({ currency0: SUMMER, currency1: PDRSTR });
    assert.deepEqual(b20PoolFromInitializeLogV1(log, PDRSTR), {
      ok: false,
      refusal: 'unsupported_quote_asset',
    });
  });

  test('a truncated data field is refused, never partially decoded', () => {
    const log = initializeLog({ currency0: USDC, currency1: PDRSTR });
    log.data = '0x' + word('0') + word('c8');
    assert.deepEqual(b20PoolFromInitializeLogV1(log, PDRSTR), { ok: false, refusal: 'malformed_log' });
  });
});

describe('the search stays inside the RPC plan', () => {
  function recordingGetLogs(logs: readonly RawLogV1[]) {
    const calls: { fromBlock: number; toBlock: number; topics: (string | null)[] }[] = [];
    return {
      calls,
      getLogs: async (query: { address: string; fromBlock: number; toBlock: number; topics: (string | null)[] }) => {
        calls.push({ fromBlock: query.fromBlock, toBlock: query.toBlock, topics: query.topics });
        // Answer only the query whose token topic matches where the token sits.
        const wants = query.topics[3];
        return logs.filter((log) => (wants ? (log.topics ?? [])[3] === wants : (log.topics ?? [])[2] === query.topics[2]));
      },
    };
  }

  test('one window, ten blocks, never wider — the plan caps getLogs at ten', async () => {
    const { calls, getLogs } = recordingGetLogs([initializeLog({ currency0: USDC, currency1: PDRSTR })]);
    const result = await resolveB20PoolV1({ token: PDRSTR, launchBlock: 49_404_602, getLogs });
    assert.equal(result.ok, true);
    for (const call of calls) {
      assert.equal(call.toBlock - call.fromBlock + 1, 10, 'a request wider than ten blocks is refused by the endpoint');
      assert.equal(call.fromBlock, 49_404_602);
    }
  });

  test('both currency positions are asked for, because either is possible', async () => {
    const { calls, getLogs } = recordingGetLogs([]);
    await resolveB20PoolV1({ token: PDRSTR, launchBlock: 100, getLogs });
    assert.equal(calls.length, 2);
    assert.ok(calls.some((call) => call.topics[3] !== null), 'token as currency1');
    assert.ok(calls.some((call) => call.topics[2] !== null), 'token as currency0');
  });

  test('no pool at all is stated as such', async () => {
    const { getLogs } = recordingGetLogs([]);
    assert.deepEqual(await resolveB20PoolV1({ token: PDRSTR, launchBlock: 1, getLogs }), {
      ok: false,
      refusal: 'no_pool_initialized',
    });
  });

  test('a real log that fails a check reports THAT, not "nothing found"', async () => {
    // "no_pool_initialized" and "quoted in a token we will not price" are
    // different operational facts and must not collapse into one.
    const { getLogs } = recordingGetLogs([initializeLog({ currency0: SUMMER, currency1: PDRSTR })]);
    assert.deepEqual(await resolveB20PoolV1({ token: PDRSTR, launchBlock: 1, getLogs }), {
      ok: false,
      refusal: 'unsupported_quote_asset',
    });
  });

  test('extra windows walk forward and stop at the first pool', async () => {
    let seen = 0;
    const getLogs = async (query: { fromBlock: number }) => {
      seen += 1;
      return query.fromBlock >= 120 ? [initializeLog({ currency0: USDC, currency1: PDRSTR })] : [];
    };
    const result = await resolveB20PoolV1({ token: PDRSTR, launchBlock: 100, getLogs, windows: 4 });
    assert.equal(result.ok, true);
    assert.ok(seen <= 8, 'stops as soon as a pool is found');
  });
});
