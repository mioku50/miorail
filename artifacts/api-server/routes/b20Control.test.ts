import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { B20ReaderV1, B20RpcResultV1 } from '@mioagent/b20-control';
import {
  InMemoryB20StorageRepositoryV1,
  InMemoryB20WatchlistRepositoryV1,
  InMemoryB20ClearanceRepositoryV1,
} from '@mioagent/route-storage';
import { b20ControlRouter, b20RouteRuntime } from './b20Control.js';

// A detonator on the global fetch: the reader is injected, so a test that
// forgets to stub it fails loudly rather than calling Base mainnet.
globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = { id: `eip155:8453:${OTHER_WALLET}`, address: OTHER_WALLET, chainId: 8453 as const };
const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301';
/** A second B20 Asset, so a sweep has more than one token to hold to one block. */
const TOKEN_TWO = '0xb2000000000000000000007bf6d5cbb0e24cb302';
const ERC20 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;
const NOW = new Date('2026-07-27T12:00:00.000Z');

const FLAGS = {
  routeIntelligenceV1: true,
  legacyTerminal: true,
  paidIntelligence: false,
  earnRouteV1: false,
  commerceRouteV1: false,
  commerceExecutionV1: false,
  nftRouteV1: false,
  nftExecutionV1: false,
  privateAiRouteV1: false,
  privateAiExecutionV1: false,
  aerodromeExecutionV1: false,
  b20ControlV1: true,
  submissionRecoveryV1: false,
  publicProofV1: false,
  routeOutcomeFeedbackV1: false,
};

const original = { ...b20RouteRuntime };
let repository: InMemoryB20StorageRepositoryV1;
let watchlist: InMemoryB20WatchlistRepositoryV1;
let clearances: InMemoryB20ClearanceRepositoryV1;
let isB20Value: boolean;
let blockNumber: string;

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}
function stringWord(text: string): string {
  const bytes = Buffer.from(text, 'utf8').toString('hex');
  return `0x${word(32n)}${word(BigInt(text.length))}${bytes.padEnd(64, '0')}`;
}

function fakeReader(): B20ReaderV1 {
  const ok = (value: string): B20RpcResultV1<string> => ({ ok: true, value, raw: value });
  return {
    async readBlockAnchor() {
      return { ok: true, value: { blockNumber, blockHash: BLOCK_HASH, blockTag: '0x1' }, raw: '' };
    },
    async readIsB20() {
      return { ok: true, value: isB20Value, raw: `0x${word(isB20Value ? 1n : 0n)}` };
    },
    async readIsB20Initialized() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async readVariantActivated() {
      return { ok: true, value: true, raw: `0x${word(1n)}` };
    },
    async call(input) {
      const selector = input.data.slice(2, 10);
      if (selector === '06fdde03' || selector === '95d89b41') return ok(stringWord('BRIAN'));
      if (selector === 'e8a3d485') return ok(stringWord('ipfs://x'));
      if (selector === '313ce567') return ok(`0x${word(18n)}`);
      if (selector === '18160ddd' || selector === '8f770ad0') return ok(`0x${word(10n ** 27n)}`);
      if (selector === 'de9997e3') return ok(`0x${word(32n)}${word(0n)}`);
      if (selector === '1b3ed722') return ok(`0x${word(10n ** 18n)}`);
      if (selector === 'e5a6b10f') return { ok: false, reason: 'reverted', revertSelector: null };
      return ok(`0x${word(0n)}`);
    },
  };
}

function app(user: typeof USER | null = USER) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', b20ControlRouter);
  return server;
}

beforeEach(() => {
  repository = new InMemoryB20StorageRepositoryV1(() => NOW);
  isB20Value = true;
  blockNumber = '49059662';
  b20RouteRuntime.flags = () => ({ ...FLAGS });
  b20RouteRuntime.repository = () => repository;
  b20RouteRuntime.reader = fakeReader;
  b20RouteRuntime.rpcConfigured = () => true;
  b20RouteRuntime.migrationAvailable = async () => true;
  b20RouteRuntime.ttlMs = () => 0;
  b20RouteRuntime.now = () => NOW;
  watchlist = new InMemoryB20WatchlistRepositoryV1();
  b20RouteRuntime.watchlist = () => watchlist;
  b20RouteRuntime.watchlistAvailable = async () => true;
  clearances = new InMemoryB20ClearanceRepositoryV1();
  b20RouteRuntime.clearances = () => clearances;
  b20RouteRuntime.clearanceAvailable = async () => true;
});

afterEach(() => {
  Object.assign(b20RouteRuntime, original);
});

function inspect(body: unknown, server = app()) {
  return request(server).post('/api/route-intelligence/b20/inspect').send(body as object);
}

describe('the gates', () => {
  test('the route is 404 while the flag is off', async () => {
    b20RouteRuntime.flags = () => ({ ...FLAGS, b20ControlV1: false });
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'b20_control_disabled');
  });

  test('an unauthenticated caller gets 401 and reaches no reader', async () => {
    let called = false;
    b20RouteRuntime.reader = () => {
      called = true;
      return fakeReader();
    };
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN }, app(null));
    assert.equal(response.status, 401);
    assert.equal(called, false);
  });

  test('a wrong chain and a malformed address are 400, with no chain read', async () => {
    let called = false;
    b20RouteRuntime.reader = () => {
      called = true;
      return fakeReader();
    };
    assert.equal((await inspect({ chainId: 84532, tokenAddress: TOKEN })).status, 400);
    assert.equal((await inspect({ chainId: 8453, tokenAddress: '0x1234' })).status, 400);
    assert.equal((await inspect({ chainId: 8453 })).status, 400);
    assert.equal(called, false, 'a refused request must never open a socket');
  });

  test('no RPC endpoint is a stable 503, not a guess', async () => {
    b20RouteRuntime.rpcConfigured = () => false;
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'b20_rpc_unavailable');
  });

  test('a missing migration is a stable 503, never a partial write', async () => {
    b20RouteRuntime.migrationAvailable = async () => false;
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'b20_storage_unavailable');
  });
});

describe('inspect', () => {
  test('a B20 token returns a card bound to one block, with evidence', async () => {
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.card.detectionOutcome, 'b20');
    assert.equal(response.body.card.blockNumber, '49059662');
    assert.equal(response.body.cached, false);
    assert.ok(response.body.evidence.length > 0);
    assert.ok(
      response.body.evidence.every(
        (record: { blockNumber: string; blockHash: string }) =>
          record.blockNumber === '49059662' && record.blockHash === BLOCK_HASH,
      ),
    );
  });

  test('an ordinary ERC-20 is told so, and gets no control claims', async () => {
    isB20Value = false;
    const response = await inspect({ chainId: 8453, tokenAddress: ERC20 });
    assert.equal(response.status, 200);
    assert.equal(response.body.card.detectionOutcome, 'not_b20');
    assert.equal(response.body.status, 'not_b20');
    assert.deepEqual(response.body.card.statements, []);
  });

  test('nothing in the response prepares, approves or signs anything', async () => {
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    const serialised = JSON.stringify(response.body).toLowerCase();
    // `methodSignature` is a legitimate evidence field, so the check names the
    // things that would indicate a signable payload rather than the word
    // "signature" itself.
    for (const banned of ['calldata', 'sendcalls', 'blueprint', 'approvedcalls', 'privatekey', 'rawtransaction', 'to sign']) {
      assert.equal(serialised.includes(banned), false, `a read-only card must not mention ${banned}`);
    }
  });

  test('the response carries no score of any kind', async () => {
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    const serialised = JSON.stringify(response.body).toLowerCase();
    for (const banned of ['safety score', 'overall confidence', 'safe token', 'unsafe token', '/100']) {
      assert.equal(serialised.includes(banned), false);
    }
  });

  test('re-inspecting in the same block re-reads the stored snapshot', async () => {
    const first = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    const second = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(first.body.snapshotId, second.body.snapshotId);
    assert.equal(first.body.card.cardHash, second.body.card.cardHash);
  });

  test('inside the TTL the chain is not read again, and the answer says it is cached', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    let reads = 0;
    b20RouteRuntime.ttlMs = () => 30_000;
    b20RouteRuntime.reader = () => {
      reads += 1;
      return fakeReader();
    };
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(response.status, 200);
    assert.equal(response.body.cached, true);
    assert.equal(reads, 0, 'a cached answer must not re-read the chain');
  });

  test('a new block produces a new snapshot rather than replacing the old one', async () => {
    const first = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    blockNumber = '49060000';
    const second = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.notEqual(first.body.snapshotId, second.body.snapshotId);
    const stored = await request(app()).get(`/api/route-intelligence/b20/snapshots/${first.body.snapshotId}`);
    assert.equal(stored.status, 200, 'the earlier snapshot is still readable');
    assert.equal(stored.body.card.blockNumber, '49059662');
  });
});

// ---------------------------------------------------------------------------
// T67F — Control Watch. The route's job is to capture the PREVIOUS snapshot
// before it writes the new one; the diff itself is covered by b20Watch.test.ts.
// ---------------------------------------------------------------------------

describe('the portfolio sweep', () => {
  function sweep(body: unknown, server = app()) {
    return request(server).post('/api/route-intelligence/b20/watch').send(body as object);
  }

  test('every requested token gets a row, and none is invented', async () => {
    const response = await sweep({ chainId: 8453, tokens: [TOKEN, ERC20] });
    assert.equal(response.status, 200);
    assert.equal(response.body.tokens.length, 2);
    assert.deepEqual(response.body.notChecked, []);
  });

  test('a non-B20 token is an ordinary answer, not a finding', async () => {
    isB20Value = false;
    const response = await sweep({ chainId: 8453, tokens: [ERC20] });
    assert.equal(response.body.tokens[0].outcome, 'not_b20');
  });

  test('a duplicate address is read once', async () => {
    // A portfolio can list the same address twice, and each duplicate would be
    // a second paid read of the same fact.
    const response = await sweep({ chainId: 8453, tokens: [TOKEN, TOKEN] });
    assert.equal(response.status, 200);
    assert.equal(response.body.tokens.length, 1);
  });

  test('inside the TTL the two most recent STORED snapshots are compared', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    blockNumber = '49060000';
    await inspect({ chainId: 8453, tokenAddress: TOKEN });

    // The guarantee is about the EXPENSIVE read: a full control card is 17
    // eth_calls, batched into a handful of requests, and must not repeat inside
    // the TTL however few round trips it now takes. The balance is
    // one call and is not stored on the snapshot, so it is read every sweep —
    // otherwise a cached token would show no balance at all, which is most of
    // them and the whole reason the portfolio exists.
    let inspections = 0;
    b20RouteRuntime.watchTtlMs = () => 600_000;
    b20RouteRuntime.reader = () => {
      const reader = fakeReader();
      return {
        ...reader,
        async readIsB20(...args: Parameters<typeof reader.readIsB20>) {
          inspections += 1;
          return reader.readIsB20(...args);
        },
      };
    };
    const response = await sweep({ chainId: 8453, tokens: [TOKEN] });
    assert.equal(inspections, 0, 'a fresh sweep must not re-inspect the controls');
    // The point of recentSnapshots: latestSnapshot alone would diff the cached
    // row against itself and report nothing, forever.
    assert.equal(response.body.tokens[0].watch.status, 'compared');
    assert.equal(response.body.tokens[0].watch.fromBlock, '49059662');
    assert.equal(response.body.tokens[0].watch.toBlock, '49060000');
  });

  test('the whole sweep is read at one block, so its rows can be compared', async () => {
    // Tokens shown side by side must be read at the same block. A per-token
    // anchor would produce a page of snapshots straddling several blocks with
    // nothing to say which — and it would cost two extra calls per token.
    let anchors = 0;
    const blocks = new Set<string>();
    b20RouteRuntime.reader = () => {
      const reader = fakeReader();
      return {
        ...reader,
        async readBlockAnchor() {
          anchors += 1;
          // A moving chain: if inspection took its own anchor, the tokens would
          // land on different blocks and this test would see them.
          blockNumber = String(Number(blockNumber) + 1);
          return reader.readBlockAnchor();
        },
      };
    };
    const response = await sweep({ chainId: 8453, tokens: [TOKEN, TOKEN_TWO] });
    assert.equal(response.status, 200);
    assert.equal(anchors, 1, 'one block for the sweep, not one per token');
    for (const token of response.body.tokens) blocks.add(token.watch.toBlock);
    assert.equal(blocks.size, 1, `every row must share a block, got ${[...blocks].join(', ')}`);
  });

  test('one reader serves the sweep, so what it learns about the endpoint survives', async () => {
    // The reader carries the backoff it learned from a throttle, the endpoint's
    // retry-after and whether batches are accepted. Building one per token threw
    // all of that away and re-provoked the same rate limit on every token.
    let readers = 0;
    b20RouteRuntime.reader = () => {
      readers += 1;
      return fakeReader();
    };
    const response = await sweep({ chainId: 8453, tokens: [TOKEN, TOKEN_TWO, ERC20] });
    assert.equal(response.status, 200);
    assert.equal(readers, 1);
  });

  test('a sweep that runs out of time answers with what it read and names the rest', async () => {
    // A throttled endpoint does not fail, it answers slowly. Without a deadline
    // the caller waits for a request that outlives the browser and sees nothing
    // — including the tokens that WERE read.
    let clock = 0;
    b20RouteRuntime.monotonicMs = () => (clock += 15_000);
    b20RouteRuntime.watchDeadlineMs = () => 20_000;
    const response = await sweep({ chainId: 8453, tokens: [TOKEN, TOKEN_TWO, ERC20] });
    assert.equal(response.status, 200);
    assert.equal(response.body.tokens.length, 1, 'the first token was read before time ran out');
    // Named, not silently dropped: "not reached" and "unchanged" are different
    // claims and the page has to be able to tell them apart.
    assert.deepEqual(response.body.notChecked, [TOKEN_TWO, ERC20]);
  });

  test('an endpoint that goes quiet is not a verdict about anyone’s tokens', async () => {
    b20RouteRuntime.reader = () => ({
      ...fakeReader(),
      async readBlockAnchor() {
        return { ok: false, reason: 'rpc_timeout' };
      },
    });
    const response = await sweep({ chainId: 8453, tokens: [TOKEN] });
    assert.equal(response.status, 503);
    // Distinct from `b20_rpc_unavailable`, which means nothing is configured.
    // An operator reading the two lines has to be able to tell them apart.
    assert.equal(response.body.code, 'b20_rpc_no_answer');
  });

  test('the wire refuses more tokens than the sweep budget allows', async () => {
    const many = Array.from({ length: 26 }, (_value, index) =>
      `0x${(index + 1).toString(16).padStart(40, '0')}`,
    );
    const response = await sweep({ chainId: 8453, tokens: many });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_b20_watch_request');
  });

  test('the sweep is behind the same gate as inspection', async () => {
    b20RouteRuntime.flags = () => ({ ...FLAGS, b20ControlV1: false });
    const response = await sweep({ chainId: 8453, tokens: [TOKEN] });
    assert.equal(response.status, 404);
  });

  test('an unauthenticated sweep is refused', async () => {
    const response = await sweep({ chainId: 8453, tokens: [TOKEN] }, app(null));
    assert.equal(response.status, 401);
  });
});

describe('the exit check', () => {
  const check = (body: unknown, server = app()) =>
    request(server).post('/api/route-intelligence/b20/exit-check').send(body as object);
  const PROFILE = { chainId: 8453, positionAtomic: '100000000', maxRoundTripBps: 300, maxSlippageBps: 300 };

  test('a token whose controls were never read is refused, not assumed open', async () => {
    // An exit check that skipped the controls would clear a token whose
    // transfers are paused — the exact failure this rail exists to prevent.
    let quoted = false;
    b20RouteRuntime.aerodromeReader = () => {
      quoted = true;
      return original.aerodromeReader();
    };
    const response = await check({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'b20_controls_unread');
    assert.equal(quoted, false, 'a refused check must not quote anything');
  });

  test('a malformed request is refused before any read', async () => {
    assert.equal((await check({ ...PROFILE, tokenAddress: '0x1234' })).status, 400);
    assert.equal((await check({ ...PROFILE, tokenAddress: TOKEN, maxSlippageBps: 0 })).status, 400);
    // No position at all is a request that cannot be answered, not one that
    // gets a default someone did not choose.
    assert.equal((await check({ ...PROFILE, tokenAddress: TOKEN, positionAtomic: '0' })).status, 400);
  });

  test('a stored snapshot supplies the controls, and the answer dates them', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.aerodromeReader = () => ({
      async readDefaultFactory() {
        return { ok: true, value: '0x420dd381b31aef6683db6b902084cb0ffece40da' as const };
      },
      async readAmountsOut() {
        // No pool anywhere. An ordinary answer about this pair.
        return { ok: false, reason: 'no_route' };
      },
      async readBlockNumber() {
        return blockNumber;
      },
      async readAllowance() {
        return { ok: true, value: 0n };
      },
    });
    const response = await check({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'rejected');
    assert.equal(response.body.reason, 'no_entry_route');
    // The two halves are dated independently rather than implied simultaneous.
    assert.equal(response.body.controlsBlockNumber, blockNumber);
    assert.equal(response.body.endpointDegraded, false);
  });

  test('nothing in the response prepares, approves or signs anything', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.aerodromeReader = () => ({
      async readDefaultFactory() {
        return { ok: true, value: '0x420dd381b31aef6683db6b902084cb0ffece40da' as const };
      },
      async readAmountsOut() {
        return { ok: false, reason: 'no_route' };
      },
      async readBlockNumber() {
        return blockNumber;
      },
      async readAllowance() {
        return { ok: true, value: 0n };
      },
    });
    const response = await check({ ...PROFILE, tokenAddress: TOKEN });
    const body = JSON.stringify(response.body);
    for (const forbidden of ['calls', 'calldata', 'to', 'router', 'approval', 'blueprint', 'signature']) {
      assert.ok(!new RegExp(`"${forbidden}"`).test(body), `an exit check must not return ${forbidden}`);
    }
  });

  test('the exit check is behind the same gate as inspection', async () => {
    b20RouteRuntime.flags = () => ({ ...FLAGS, b20ControlV1: false });
    assert.equal((await check({ ...PROFILE, tokenAddress: TOKEN })).status, 404);
  });

  test('an unauthenticated caller reaches no router', async () => {
    let quoted = false;
    b20RouteRuntime.aerodromeReader = () => {
      quoted = true;
      return original.aerodromeReader();
    };
    assert.equal((await check({ ...PROFILE, tokenAddress: TOKEN }, app(null))).status, 401);
    assert.equal(quoted, false);
  });

  test('no RPC endpoint is a stable 503, not a guess', async () => {
    b20RouteRuntime.rpcConfigured = () => false;
    const response = await check({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'b20_rpc_unavailable');
  });
});

describe('only a sequential simulation opens the entry route', () => {
  const PROFILE = { chainId: 8453, positionAtomic: '100000000', maxRoundTripBps: 300, maxExitSlippageBps: 300 };
  const simulate = (body: unknown, server = app()) =>
    request(server).post('/api/route-intelligence/b20/opportunity/simulate').send(body as object);

  /** A run that certifies. Injected, so the route is tested without a chain. */
  function certifiedRun() {
    const route = [{ from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', to: TOKEN, stable: false, factory: '0x420dd381b31aef6683db6b902084cb0ffece40da' }];
    return async () => ({
      certified: {
        outcome: { viability: 'qualified' as const },
        coverage: { coverage: 'partial' as const, viableRouteConfirmed: true, bestRouteConfirmed: false },
        simulatedRoundTripBps: 120,
        simulatedReturnedAtomic: '98800000',
        simulatedAcquiredAtomic: '4200000000000000000000',
        simulationBlockNumber: '49450001',
      },
      entryRoute: route,
      exitRoute: route,
      calls: [],
      simulationEvidenceHash: `0x${'e'.repeat(64)}`,
    });
  }

  test('a token whose controls were never read is refused before any simulation', async () => {
    let ran = false;
    b20RouteRuntime.runOpportunity = (async () => {
      ran = true;
      throw new Error('unreachable');
    }) as never;
    const response = await simulate({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'b20_controls_unread');
    assert.equal(ran, false);
  });

  test('a control refusal is decided before any simulation is spent', async () => {
    // Controls are prior to price and prior to simulation. A token the factory
    // does not recognise has no round trip worth computing, and computing one
    // would put a number where a refusal belongs.
    isB20Value = false;
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    let ran = false;
    b20RouteRuntime.runOpportunity = (async () => {
      ran = true;
      throw new Error('unreachable');
    }) as never;
    const response = await simulate({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.viability, 'rejected');
    assert.equal(response.body.rejectionReason, 'not_b20');
    assert.equal(response.body.clearanceId, null, 'a rejection never issues a clearance');
    assert.equal(ran, false);
  });

  test('a profile outside the server bounds is refused with the field named', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    // 0.5 USDC — below the probe floor.
    const small = await simulate({ ...PROFILE, tokenAddress: TOKEN, positionAtomic: '500000' });
    assert.equal(small.status, 400);
    assert.equal(small.body.code, 'position_below_minimum');
    const wide = await simulate({ ...PROFILE, tokenAddress: TOKEN, maxRoundTripBps: 9_000 });
    assert.equal(wide.status, 400);
    assert.equal(wide.body.code, 'round_trip_tolerance_too_wide');
  });

  test('a certified round trip issues a clearance bound to wallet, token and profile', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.runOpportunity = certifiedRun() as never;
    const response = await simulate({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.viability, 'qualified');
    assert.ok(response.body.clearanceId);
    assert.ok(response.body.expiresAt, 'a clearance without an expiry is an allowlist entry');
    // Viable, but not best — some candidates did not answer.
    assert.equal(response.body.viableRouteConfirmed, true);
    assert.equal(response.body.bestRouteConfirmed, false);
    assert.equal(response.body.coverage, 'partial');

    const stored = await clearances.getClearance(response.body.clearanceId, USER.id);
    assert.ok(stored);
    assert.equal(stored!.walletAddress, WALLET);
    assert.equal(stored!.tokenAddress, TOKEN);
    assert.equal(stored!.positionAtomic, '100000000');
  });

  test('another wallet cannot read the clearance', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.runOpportunity = certifiedRun() as never;
    const response = await simulate({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(await clearances.getClearance(response.body.clearanceId, OTHER.id), null);
  });

  test('a degraded run is unmeasured and issues nothing', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.runOpportunity = (async () => ({
      certified: {
        outcome: { viability: 'unmeasured' as const, reason: 'insufficient_probe_balance' as const },
        coverage: { coverage: 'partial' as const, viableRouteConfirmed: false, bestRouteConfirmed: false },
        simulatedRoundTripBps: null,
        simulatedReturnedAtomic: null,
        simulatedAcquiredAtomic: null,
        simulationBlockNumber: null,
      },
      entryRoute: null,
      exitRoute: null,
      calls: null,
      simulationEvidenceHash: null,
    })) as never;
    const response = await simulate({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(response.body.viability, 'unmeasured');
    // A wallet's balance is not a property of the token.
    assert.equal(response.body.unmeasuredReason, 'insufficient_probe_balance');
    assert.equal(response.body.rejectionReason, null);
    assert.equal(response.body.clearanceId, null);
  });

  test('a server without migration 0025 still simulates, and certifies nothing', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.clearanceAvailable = async () => false;
    b20RouteRuntime.runOpportunity = certifiedRun() as never;
    const response = await simulate({ ...PROFILE, tokenAddress: TOKEN });
    assert.equal(response.status, 200);
    assert.equal(response.body.viability, 'qualified');
    assert.equal(response.body.clearanceId, null, 'no store, no clearance, no entry');
  });

  test('nothing in the response prepares, approves or signs anything', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.runOpportunity = certifiedRun() as never;
    const body = JSON.stringify((await simulate({ ...PROFILE, tokenAddress: TOKEN })).body);
    for (const forbidden of ['calls', 'calldata', 'router', 'signature', 'blueprint']) {
      assert.ok(!new RegExp(`"${forbidden}"`).test(body), `must not return ${forbidden}`);
    }
  });

  test('the free exit check can never say qualified', async () => {
    // The promotion rule, at the wire. A quote may reject; only a simulation
    // may certify.
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.aerodromeReader = () => ({
      async readDefaultFactory() {
        return { ok: true as const, value: '0x420dd381b31aef6683db6b902084cb0ffece40da' as const };
      },
      async readAmountsOut() {
        return { ok: false as const, reason: 'no_route' as const };
      },
      async readBlockNumber() {
        return blockNumber;
      },
      async readAllowance() {
        return { ok: true as const, value: 0n };
      },
    });
    const response = await request(app())
      .post('/api/route-intelligence/b20/exit-check')
      .send({ chainId: 8453, tokenAddress: TOKEN, positionAtomic: '100000000', maxRoundTripBps: 300, maxSlippageBps: 300 });
    assert.equal(response.status, 200);
    assert.notEqual(response.body.status, 'qualified');
    assert.notEqual(response.body.status, 'qualifies');
    // And a quote proves no route executes.
    assert.equal(response.body.viableRouteConfirmed, false);
  });

  test('the simulate route is behind the same gate and needs a session', async () => {
    b20RouteRuntime.flags = () => ({ ...FLAGS, b20ControlV1: false });
    assert.equal((await simulate({ ...PROFILE, tokenAddress: TOKEN })).status, 404);
    b20RouteRuntime.flags = () => ({ ...FLAGS });
    assert.equal((await simulate({ ...PROFILE, tokenAddress: TOKEN }, app(null))).status, 401);
  });
});

describe('a clearance is consumed, never trusted', () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const prepare = (clearanceId: string, body: unknown, server = app()) =>
    request(server)
      .post(`/api/route-intelligence/opportunities/${clearanceId}/prepare-entry`)
      .send(body as object);
  const REQUEST = { chainId: 8453, profileIdentity: `${USDC}:100000000:300:300`, requestId: 'req-1' };

  /** A prepared plan, injected — the runner has its own unit tests. */
  const preparedRun = (calls = 2) =>
    (async () => ({
      blueprint: {
        blueprintHash: `0x${'b'.repeat(64)}`,
        expectedOutputAtomic: '4200000000000000000000',
        minimumOutputAtomic: '4074000000000000000000',
        entrySourceKey: `aerodrome:0xfac:${USDC}:${TOKEN}:volatile`,
        coverage: 'partial' as const,
        prepareControlBlockNumber: '49450050',
        calls: Array.from({ length: calls }, (_value, index) => ({
          to: index === 0 ? USDC : '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
          data: '0x095ea7b3',
          valueWei: '0',
        })),
      },
      refusal: null,
      detail: null,
      tokenAddress: TOKEN,
    })) as never;

  async function seedClearance(overrides: Record<string, unknown> = {}) {
    const { B20OpportunityClearanceV1Schema, B20_CLEARANCE_TTL_MS_V1 } = await import(
      '@mioagent/route-storage'
    );
    const clearance = B20OpportunityClearanceV1Schema.parse({
      schemaVersion: 'b20-opportunity-clearance/v1',
      id: 'clearance-1',
      tenantId: USER.id,
      walletAddress: WALLET,
      chainId: 8453,
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      positionAtomic: '100000000',
      maxRoundTripBps: 300,
      maxExitSlippageBps: 300,
      profileIdentity: `${USDC}:100000000:300:300`,
      controlSnapshotHash: `0x${'a'.repeat(64)}`,
      controlBlockNumber: '49450000',
      entryRouteHash: `0x${'b'.repeat(64)}`,
      exitRouteHash: `0x${'c'.repeat(64)}`,
      entrySourceKey: `aerodrome:0xfac:${USDC}:${TOKEN}:volatile`,
      exitSourceKey: `aerodrome:0xfac:${TOKEN}:${USDC}:volatile`,
      simulationRequestHash: `0x${'d'.repeat(64)}`,
      simulationEvidenceHash: `0x${'e'.repeat(64)}`,
      simulationBlockNumber: '49450001',
      entryProvider: 'aerodrome',
      viability: 'qualified',
      coverage: 'partial',
      viableRouteConfirmed: true,
      bestRouteConfirmed: false,
      simulatedReturnedAtomic: '99000000',
      simulatedAcquiredAtomic: '4200000000000000000000',
      simulatedRoundTripBps: 100,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1).toISOString(),
      ...overrides,
    });
    await clearances.insertClearance(clearance);
    return clearance;
  }

  test('a prepared plan returns unsigned calls and nothing else', async () => {
    await seedClearance();
    b20RouteRuntime.prepareEntry = preparedRun();
    const response = await prepare('clearance-1', REQUEST);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.outcome, 'prepared');
    assert.equal(response.body.calls.length, 2);
    // Unsigned: no signature, no hash of a broadcast, nothing to send.
    const body = JSON.stringify(response.body);
    for (const forbidden of ['signature', 'rawTransaction', 'privateKey', 'txHash']) {
      assert.ok(!new RegExp(forbidden, 'i').test(body), `must not return ${forbidden}`);
    }
    // Viable, but not best — and the response says both.
    assert.equal(response.body.viableRouteConfirmed, true);
    assert.equal(response.body.bestRouteConfirmed, false);
    assert.equal(response.body.coverage, 'partial');
  });

  test('the request may not name a token, a route, an amount or calldata', async () => {
    await seedClearance();
    b20RouteRuntime.prepareEntry = preparedRun();
    // A strict schema: anything executable in the body is a 400, not a field
    // that gets quietly ignored.
    for (const extra of [
      { tokenAddress: ERC20 },
      { calls: [{ to: ERC20, data: '0xdeadbeef', value: '0' }] },
      { positionAtomic: '999000000' },
      { route: [{ from: USDC, to: ERC20 }] },
      { recipient: OTHER_WALLET },
    ]) {
      const response = await prepare('clearance-1', { ...REQUEST, ...extra });
      assert.equal(response.status, 400, JSON.stringify(extra));
    }
  });

  test('a missing clearance is a refusal with no plan', async () => {
    const response = await prepare('nope', REQUEST);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'refused');
    assert.equal(response.body.refusalReason, 'clearance_missing');
    assert.equal(response.body.calls, null);
  });

  test('another wallet’s clearance is not even found', async () => {
    await seedClearance();
    const response = await prepare('clearance-1', REQUEST, app(OTHER));
    assert.equal(response.body.outcome, 'refused');
    assert.equal(response.body.calls, null);
  });

  test('a profile the caller restates differently is refused', async () => {
    await seedClearance();
    const response = await prepare('clearance-1', {
      ...REQUEST,
      profileIdentity: `${USDC}:500000000:300:300`,
    });
    assert.equal(response.body.outcome, 'refused');
    assert.equal(response.body.refusalReason, 'clearance_profile_mismatch');
  });

  test('an expired clearance is refused', async () => {
    const { B20_CLEARANCE_TTL_MS_V1 } = await import('@mioagent/route-storage');
    await seedClearance();
    b20RouteRuntime.now = () => new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1 + 1_000);
    const response = await prepare('clearance-1', REQUEST);
    assert.equal(response.body.outcome, 'refused');
    assert.equal(response.body.refusalReason, 'clearance_expired');
  });

  test('a runner refusal exposes no calls, and names the binding', async () => {
    await seedClearance();
    b20RouteRuntime.prepareEntry = (async () => ({
      blueprint: null,
      refusal: 'entry_transfers_paused',
      detail: 'Transfers of this token are paused now.',
      tokenAddress: TOKEN,
    })) as never;
    const response = await prepare('clearance-1', REQUEST);
    assert.equal(response.body.outcome, 'refused');
    assert.equal(response.body.refusalReason, 'entry_transfers_paused');
    assert.equal(response.body.calls, null);
    // Never a provider body, an endpoint or a key.
    assert.equal(/https?:\/\//.test(JSON.stringify(response.body)), false);
  });

  test('preparation is idempotent for one request', async () => {
    await seedClearance();
    b20RouteRuntime.prepareEntry = preparedRun();
    const first = await prepare('clearance-1', REQUEST);
    const second = await prepare('clearance-1', REQUEST);
    assert.equal(first.body.blueprintHash, second.body.blueprintHash);
  });

  test('the route needs the flag and a session', async () => {
    b20RouteRuntime.flags = () => ({ ...FLAGS, b20ControlV1: false });
    assert.equal((await prepare('clearance-1', REQUEST)).status, 404);
    b20RouteRuntime.flags = () => ({ ...FLAGS });
    assert.equal((await prepare('clearance-1', REQUEST, app(null))).status, 401);
  });

  test('a server without the clearance table prepares nothing', async () => {
    b20RouteRuntime.clearanceAvailable = async () => false;
    const response = await prepare('clearance-1', REQUEST);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'b20_clearance_unavailable');
  });
});

describe('the watchlist a background sweep reads', () => {
  const list = (server = app()) => request(server).get('/api/route-intelligence/b20/watchlist');
  const add = (body: unknown, server = app()) =>
    request(server).post('/api/route-intelligence/b20/watchlist').send(body as object);
  const drop = (address: string, server = app()) =>
    request(server).delete(`/api/route-intelligence/b20/watchlist/${address}`);

  test('an empty list is an empty list, and says how many slots remain', async () => {
    const response = await list();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.tokens, []);
    assert.equal(response.body.remaining, 25);
  });

  test('an added token comes back with no reading, not with a blank one', async () => {
    // "Never read" and "nothing changed" must not render alike, so the wire
    // carries null rather than a timestamp nobody earned.
    const response = await add({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(response.status, 201);
    assert.equal(response.body.tokens.length, 1);
    assert.equal(response.body.tokens[0].lastSweptAt, null);
    assert.equal(response.body.tokens[0].lastOutcome, null);
    assert.equal(response.body.remaining, 24);
  });

  test('adding the same token twice is one row', async () => {
    await add({ chainId: 8453, tokenAddress: TOKEN });
    // Checksummed, the way a wallet shows it. The wire lowercases; the list
    // must not gain a second row for the same token spelled differently.
    const response = await add({ chainId: 8453, tokenAddress: `0x${TOKEN.slice(2).toUpperCase()}` });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.tokens.length, 1);
    assert.equal(response.body.tokens[0].tokenAddress, TOKEN);
  });

  test('a full list is 409 and names the cap, not 400', async () => {
    for (let index = 1; index <= 25; index += 1) {
      await add({ chainId: 8453, tokenAddress: `0x${index.toString(16).padStart(40, '0')}` });
    }
    const response = await add({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'b20_watchlist_full');
    assert.match(response.body.detail, /25/);
  });

  test('a malformed address is refused before any write', async () => {
    assert.equal((await add({ chainId: 8453, tokenAddress: '0x1234' })).status, 400);
    assert.equal((await add({ chainId: 84532, tokenAddress: TOKEN })).status, 400);
    assert.equal((await list()).body.tokens.length, 0);
  });

  test('removing something that is not there is not an error', async () => {
    // Two tabs must not turn one removal into a 404.
    const response = await drop(TOKEN);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.tokens, []);
  });

  test('one account never sees another’s watchlist', async () => {
    await add({ chainId: 8453, tokenAddress: TOKEN });
    const response = await list(app(OTHER));
    assert.deepEqual(response.body.tokens, []);
  });

  test('a server without the migration says so instead of pretending the list is empty', async () => {
    b20RouteRuntime.watchlistAvailable = async () => false;
    const response = await list();
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'b20_watchlist_unavailable');
  });

  test('an interactive sweep counts as a reading', async () => {
    // Otherwise the background sweep would re-read, minutes later, a token the
    // user just paid to read — and the page would still say "not read yet".
    await add({ chainId: 8453, tokenAddress: TOKEN });
    await request(app())
      .post('/api/route-intelligence/b20/watch')
      .send({ chainId: 8453, tokens: [TOKEN] });
    const response = await list();
    assert.equal(response.body.tokens[0].lastSweptAt, NOW.toISOString());
    assert.equal(response.body.tokens[0].lastOutcome, 'read');
  });

  test('a sweep on a server without the watchlist still sweeps', async () => {
    // Migration 0024 is not a precondition for inspection. A server that has
    // not run it must keep answering, without a watchlist clock to update.
    b20RouteRuntime.watchlistAvailable = async () => false;
    const response = await request(app())
      .post('/api/route-intelligence/b20/watch')
      .send({ chainId: 8453, tokens: [TOKEN] });
    assert.equal(response.status, 200);
    assert.equal(response.body.tokens.length, 1);
  });

  test('the watchlist is behind the same gate as inspection', async () => {
    b20RouteRuntime.flags = () => ({ ...FLAGS, b20ControlV1: false });
    assert.equal((await list()).status, 404);
    assert.equal((await add({ chainId: 8453, tokenAddress: TOKEN })).status, 404);
  });

  test('an unauthenticated caller reaches no list', async () => {
    assert.equal((await list(app(null))).status, 401);
    assert.equal((await add({ chainId: 8453, tokenAddress: TOKEN }, app(null))).status, 401);
  });
});

describe('the control watch compares against the previous reading', () => {
  test('a first inspection has nothing to compare against', async () => {
    const response = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(response.status, 200);
    assert.equal(response.body.watch.status, 'first_observation');
    assert.deepEqual(response.body.watch.changes, []);
  });

  test('a later block is compared against the earlier one', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    blockNumber = '49060000';
    const second = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    // The previous snapshot must be read BEFORE the insert. Reading it after
    // would compare the new snapshot against itself and report no change,
    // forever — a watch that is always silent and always looks healthy.
    assert.equal(second.body.watch.status, 'compared');
    assert.equal(second.body.watch.fromBlock, '49059662');
    assert.equal(second.body.watch.toBlock, '49060000');
  });

  test('a cache hit carries no watch at all', async () => {
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    b20RouteRuntime.ttlMs = () => 30_000;
    const cached = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    assert.equal(cached.body.cached, true);
    // Absent, not an empty change list: the answer IS the stored snapshot, so
    // there is no newer reading. An empty list would say "nothing changed" on
    // the strength of not having looked.
    assert.equal(cached.body.watch, undefined);
  });

  test('another tenant\u2019s earlier reading is never the baseline', async () => {
    // latestSnapshot is scoped by tenant, so one wallet's history cannot
    // become another wallet's "was".
    await inspect({ chainId: 8453, tokenAddress: TOKEN });
    blockNumber = '49060000';
    const other = await inspect({ chainId: 8453, tokenAddress: TOKEN }, app(OTHER));
    assert.equal(other.body.watch.status, 'first_observation');
  });
});

describe('the wire contract tracks the domain contract', () => {
  test('every field status the domain can produce is one the response may carry', async () => {
    // These two enums are written out twice, so they can drift. When they do,
    // a card that reads perfectly fails response validation and the caller
    // gets a 500 — which is how `not_enumerable` first showed up.
    const { B20FieldStatusV1Schema } = await import('@mioagent/b20-control');
    const { B20ControlCardResponseV1Schema } = await import('@mioagent/api-zod');
    const wire = (
      B20ControlCardResponseV1Schema.shape.fields.element.shape.status as unknown as { options: string[] }
    ).options;
    assert.deepEqual([...B20FieldStatusV1Schema.options].sort(), [...wire].sort());
  });
});

describe('snapshots', () => {
  test('a stored snapshot is readable by its owner and marked cached', async () => {
    const created = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    const response = await request(app()).get(`/api/route-intelligence/b20/snapshots/${created.body.snapshotId}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.cached, true);
    assert.equal(response.body.card.cardHash, created.body.card.cardHash);
  });

  test('another tenant gets 404, not a refusal that confirms it exists', async () => {
    const created = await inspect({ chainId: 8453, tokenAddress: TOKEN });
    const response = await request(app(OTHER)).get(
      `/api/route-intelligence/b20/snapshots/${created.body.snapshotId}`,
    );
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'b20_snapshot_not_found');
  });

  test('an unknown id is 404', async () => {
    const response = await request(app()).get('/api/route-intelligence/b20/snapshots/b20-snapshot:nope');
    assert.equal(response.status, 404);
  });
});
