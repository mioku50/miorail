import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';
import type { B20BatchCallV1, B20BlockAnchorV1, B20ReaderV1, B20RpcResultV1 } from '@mioagent/b20-control';
import type { RpcCuLedgerRepositoryV1 } from '@mioagent/route-storage';

import {
  ALCHEMY_REFUSAL_COOLDOWN_MS_V1,
  createBudgetedReaderV1,
  lastAlchemyRefusalV1,
  resetAlchemyRefusalV1,
} from './budgetedRpc.js';

// ---------------------------------------------------------------------------
// 2026-10-25: another project on the same Alchemy account spent the account's
// month. Every call came back HTTP 429 "Monthly capacity limit exceeded" while
// our ledger read 6.9M of 300M CU and kept choosing Alchemy, so the cash-exit
// ladder failed every pass with a healthy fallback configured. These tests pin
// the rule that replaced it: Alchemy's refusal outranks our ledger.
// ---------------------------------------------------------------------------

const ANCHOR = {
  blockNumber: '53107445',
  blockHash: `0x${'ab'.repeat(32)}`,
  blockTag: '0x32a5af5',
} as B20BlockAnchorV1;

const TOKEN_A = '0x000000000000000000000000000000000000000a';
const TOKEN_B = '0x000000000000000000000000000000000000000b';
const TOKEN_C = '0x000000000000000000000000000000000000000c';

function ok<T>(value: T): B20RpcResultV1<T> {
  return { ok: true, value, raw: JSON.stringify(value) };
}

interface EndpointScriptV1 {
  anchor?: B20RpcResultV1<B20BlockAnchorV1>;
  call?: (input: B20BatchCallV1) => B20RpcResultV1<string>;
}

function endpoint(name: string, asked: string[], script: EndpointScriptV1 = {}): B20ReaderV1 {
  const answer = (input: B20BatchCallV1) => (script.call ? script.call(input) : ok(`0x${name}`));
  const unused = async (): Promise<never> => {
    throw new Error('not read in these tests');
  };
  return {
    async readBlockAnchor() {
      asked.push(`${name}:anchor`);
      return script.anchor ?? ok(ANCHOR);
    },
    readIsB20: unused,
    readIsB20Initialized: unused,
    readVariantActivated: unused,
    async call(input) {
      asked.push(`${name}:call:${input.to}`);
      return answer(input);
    },
    async callMany(inputs) {
      asked.push(`${name}:callMany:${inputs.map((input) => input.to).join(',')}`);
      return inputs.map(answer);
    },
  };
}

function ledger(): RpcCuLedgerRepositoryV1 & { spends: { provider: string; calls: number }[] } {
  const spends: { provider: string; calls: number }[] = [];
  return {
    spends,
    async recordSpend(input) {
      spends.push({ provider: input.provider, calls: input.calls });
    },
    async readMonth() {
      return [];
    },
  };
}

function budgeted(input: {
  alchemy: B20ReaderV1;
  fallback: B20ReaderV1;
  ledger?: RpcCuLedgerRepositoryV1;
  now?: () => Date;
}): B20ReaderV1 {
  return createBudgetedReaderV1({
    alchemyUrl: 'alchemy-endpoint',
    fallbackUrl: 'fallback-endpoint',
    ledger: input.ledger ?? ledger(),
    now: input.now,
    readerFor: (rpcUrl) => (rpcUrl === 'alchemy-endpoint' ? input.alchemy : input.fallback),
  });
}

const call = (to: string): B20BatchCallV1 => ({ to, data: '0x313ce567', blockTag: ANCHOR.blockTag });

describe("Alchemy's refusal outranks the ledger", () => {
  beforeEach(() => resetAlchemyRefusalV1());

  test('a refused read is asked of the fallback at once, and both are billed', async () => {
    const asked: string[] = [];
    const spend = ledger();
    const reader = budgeted({
      alchemy: endpoint('alchemy', asked, { anchor: { ok: false, reason: 'rate_limited' } }),
      fallback: endpoint('fallback', asked),
      ledger: spend,
    });
    const anchor = await reader.readBlockAnchor();
    assert.deepEqual(anchor, ok(ANCHOR));
    assert.deepEqual(asked, ['alchemy:anchor', 'fallback:anchor']);
    assert.equal(lastAlchemyRefusalV1()?.reason, 'rate_limited');
    // The refused call is billed too: a budget that only counts answers drifts
    // under the real one.
    assert.deepEqual(
      spend.spends.map((row) => row.provider),
      ['alchemy', 'fallback'],
    );
  });

  test('a refusal keeps Alchemy out of every budgeted reader until the window passes', async () => {
    let at = Date.parse('2026-10-26T09:00:00.000Z');
    const now = () => new Date(at);
    const asked: string[] = [];
    const first = budgeted({
      alchemy: endpoint('alchemy', asked, { anchor: { ok: false, reason: 'rate_limited' } }),
      fallback: endpoint('fallback', asked),
      now,
    });
    await first.readBlockAnchor();

    // A second reader in the same process, as the API builds one per request.
    at += 60_000;
    asked.length = 0;
    const second = budgeted({ alchemy: endpoint('alchemy', asked), fallback: endpoint('fallback', asked), now });
    assert.deepEqual(await second.call(call(TOKEN_A)), ok('0xfallback'));
    assert.deepEqual(asked, [`fallback:call:${TOKEN_A}`]);

    // Once the window has passed, Alchemy is asked again: one refused call per
    // window is the whole cost of finding out that it is back.
    at += ALCHEMY_REFUSAL_COOLDOWN_MS_V1;
    asked.length = 0;
    assert.deepEqual(await second.call(call(TOKEN_A)), ok('0xalchemy'));
    assert.deepEqual(asked, [`alchemy:call:${TOKEN_A}`]);
  });

  test('a revert is an answer and is never asked twice', async () => {
    const asked: string[] = [];
    const reader = budgeted({
      alchemy: endpoint('alchemy', asked, { call: () => ({ ok: false, reason: 'reverted' }) }),
      fallback: endpoint('fallback', asked),
    });
    assert.deepEqual(await reader.call(call(TOKEN_A)), { ok: false, reason: 'reverted' });
    assert.deepEqual(asked, [`alchemy:call:${TOKEN_A}`]);
    assert.equal(lastAlchemyRefusalV1(), null);
  });

  test('a batch asks the fallback only for the entries Alchemy did not answer, in place', async () => {
    const asked: string[] = [];
    const spend = ledger();
    const reader = budgeted({
      alchemy: endpoint('alchemy', asked, {
        call: (input) => (input.to === TOKEN_B ? { ok: false, reason: 'rate_limited' } : ok('0xalchemy')),
      }),
      fallback: endpoint('fallback', asked),
      ledger: spend,
    });
    const answers = await reader.callMany!([call(TOKEN_A), call(TOKEN_B), call(TOKEN_C)]);
    assert.deepEqual(answers, [ok('0xalchemy'), ok('0xfallback'), ok('0xalchemy')]);
    assert.deepEqual(asked, [
      `alchemy:callMany:${TOKEN_A},${TOKEN_B},${TOKEN_C}`,
      `fallback:callMany:${TOKEN_B}`,
    ]);
    assert.deepEqual(spend.spends, [
      { provider: 'alchemy', calls: 3 },
      { provider: 'fallback', calls: 1 },
    ]);
  });

  test('when the fallback was the choice, its failure is the answer', async () => {
    const asked: string[] = [];
    const reader = createBudgetedReaderV1({
      alchemyUrl: null,
      fallbackUrl: 'fallback-endpoint',
      ledger: ledger(),
      readerFor: () => endpoint('fallback', asked, { anchor: { ok: false, reason: 'rate_limited' } }),
    });
    assert.deepEqual(await reader.readBlockAnchor(), { ok: false, reason: 'rate_limited' });
    assert.deepEqual(asked, ['fallback:anchor']);
    // Nothing about Alchemy was learned, so nothing is reported about it.
    assert.equal(lastAlchemyRefusalV1(), null);
  });
});
