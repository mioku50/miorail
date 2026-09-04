import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_ELIGIBILITY_SCOPE_SUBJECT_V1,
  B20_POLICY_REGISTRY_V1,
  type B20BatchCallV1,
  B20_SELECTORS_V1,
  b20TransferGateRefusesV1,
  b20TransferGateV1,
  readB20TransferEligibilityV1,
  type B20EligibilityVerdictV1,
  type B20ReaderV1,
  type B20TransferEligibilityV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Can this wallet move this token, and would the contract let anyone.
//
// Measured on Base 2026-08-31, at one block, on NVDAc and TSLAc: all three
// transfer scopes on both tokens point at policy id 5, whose type byte is 0x00
// — a live BLOCKLIST, not ALWAYS_ALLOW. `isAuthorized` is documented never to
// revert, and did not: an ordinary holder and the KyberSwap router both came
// back authorized, ALWAYS_ALLOW authorized every wallet tried, ALWAYS_BLOCK
// denied, an absent blocklist authorized and an absent allowlist denied.
// `isPaused` answered false for transfer, mint and burn on both.
// ---------------------------------------------------------------------------

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const WALLET = '0x1111111111111111111111111111111111111111';
const EXECUTOR = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const SCOPE_KEY = `0x${'11'.repeat(32)}`;
const ok = (value: string) => ({ ok: true as const, value });
const fail = { ok: false as const, reason: 'transport' as const };
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

/** Answers by target and selector, so a test states what the chain says rather
 * than the order the implementation happens to ask in. */
function readerV1(input: {
  scope?: (index: number) => unknown;
  policyId?: bigint | null;
  authorized?: (data: string) => unknown;
  paused?: unknown;
}): B20ReaderV1 {
  let scopeIndex = 0;
  const answer = (call: { to: string; data: string }) => {
    if (call.to.toLowerCase() === B20_POLICY_REGISTRY_V1) {
      return input.authorized?.(call.data) ?? ok(word(1n));
    }
    if (call.data.startsWith(`0x${B20_SELECTORS_V1.isPaused}`)) {
      return input.paused ?? ok(word(0n));
    }
    if (call.data.startsWith(`0x${B20_SELECTORS_V1.policyId}`)) {
      return input.policyId === null ? fail : ok(word(input.policyId ?? 5n));
    }
    const result = input.scope?.(scopeIndex) ?? ok(SCOPE_KEY);
    scopeIndex += 1;
    return result;
  };
  return {
    readBlockAnchor: async () => ({ ok: true, value: { blockTag: '0x1', blockNumber: 1n } }),
    readIsB20: async () => ({ ok: true, value: true }),
    readIsB20Initialized: async () => ({ ok: true, value: true }),
    readVariantActivated: async () => ({ ok: true, value: true }),
    call: async (call: B20BatchCallV1) => answer(call),
    callMany: async (calls: readonly B20BatchCallV1[]) => calls.map((call) => answer(call)),
  } as never;
}

const read = (
  reader: B20ReaderV1,
  extra: { wallet?: string; executor?: string | null } = {},
) =>
  readB20TransferEligibilityV1({
    reader,
    tokenAddress: TOKEN,
    wallet: extra.wallet ?? WALLET,
    executor: extra.executor ?? null,
    blockTag: '0x1',
  });

const byScope = (result: Awaited<ReturnType<typeof read>>, scope: string) =>
  result.scopes.find((row) => row.scope === scope)!;

describe('whether a wallet may move a B20', () => {
  test('a live blocklist that authorizes this wallet reads as authorized on both wallet scopes', async () => {
    const result = await read(readerV1({}));
    assert.deepEqual(
      [
        byScope(result, 'transfer_sender'),
        byScope(result, 'transfer_receiver'),
      ].map((scope) => [scope.verdict, scope.policyId, scope.policyType, scope.account]),
      [
        ['authorized', '5', 'blocklist', WALLET],
        ['authorized', '5', 'blocklist', WALLET],
      ],
    );
    assert.equal(result.transferPause.state, 'not_paused');
  });

  test('the executor is a third scope about a DIFFERENT address', async () => {
    // A sell moves the token through a router under `transferFrom`. Asking the
    // executor scope about the holder would answer a different question and
    // label it as this one.
    const seen: string[] = [];
    const base = readerV1({
      authorized: (data) => {
        seen.push(`0x${data.slice(-40)}`);
        return ok(word(1n));
      },
    });
    const result = await read(base, { executor: EXECUTOR });
    const executor = byScope(result, 'transfer_executor');
    assert.equal(executor.subject, 'executor');
    assert.equal(executor.account, EXECUTOR);
    assert.equal(executor.verdict, 'authorized');
    assert.equal(seen.filter((address) => address === EXECUTOR).length, 1);
    assert.equal(seen.filter((address) => address === WALLET).length, 2);
  });

  test('an unknown executor is not established, and never assumed to be the wallet', async () => {
    // The state every review in this build is actually in: the router is
    // chosen after this step, so no exact executor address exists to ask about.
    const result = await read(readerV1({}), { executor: null });
    const executor = byScope(result, 'transfer_executor');
    assert.equal(executor.verdict, 'not_established');
    assert.equal(executor.account, null);
    // The POLICY was read even though the address was not — the honest half of
    // the answer is kept rather than the whole scope going silent.
    assert.equal(executor.policyId, '5');
    assert.match(executor.reason ?? '', /not known at this step/);
    // And it never quietly becomes an answer about the holder.
    assert.notEqual(executor.account, WALLET);
  });

  test('a denial is reported as a denial, and names which side it applies to', async () => {
    const result = await read(
      readerV1({
        authorized: (data) => ok(word(data.endsWith(WALLET.slice(2).toLowerCase()) ? 0n : 1n)),
      }),
    );
    assert.equal(byScope(result, 'transfer_sender').verdict, 'denied');
    assert.equal(byScope(result, 'transfer_receiver').verdict, 'denied');
  });

  test('a registry that does not answer is never a denial', async () => {
    // The worst false positive this product could produce: telling a holder
    // their address is blocked because our RPC was throttled. Measured live —
    // under base.org rate limiting this is exactly the path that runs.
    const result = await read(readerV1({ authorized: () => fail }));
    assert.equal(
      result.scopes.every((scope) => scope.verdict === 'not_established'),
      true,
    );
    assert.equal(
      result.scopes.some((scope) => scope.verdict === 'denied'),
      false,
    );
    assert.equal(byScope(result, 'transfer_sender').policyId, '5');
  });

  test('an unread pause flag is not an unpaused contract', async () => {
    // The same false positive as a wrong denial, pointing the other way: a
    // green "transfers are open" built out of a throttled RPC.
    const result = await read(readerV1({ paused: fail }));
    assert.equal(result.transferPause.state, 'not_established');
    assert.match(result.transferPause.reason ?? '', /not read/);
    // And a paused contract is reported as paused, not as a per-address denial.
    const paused = await read(readerV1({ paused: ok(word(1n)) }));
    assert.equal(paused.transferPause.state, 'paused');
    assert.equal(
      paused.scopes.some((scope) => scope.verdict === 'denied'),
      false,
    );
  });

  test('sending and receiving stay separate facts', async () => {
    let seen = 0;
    const result = await read(
      readerV1({
        authorized: () => {
          seen += 1;
          return seen === 1 ? ok(word(1n)) : fail;
        },
      }),
    );
    assert.equal(byScope(result, 'transfer_sender').verdict, 'authorized');
    assert.equal(byScope(result, 'transfer_receiver').verdict, 'not_established');
  });

  test('a token that will not name a scope is unresolved, not open', async () => {
    const result = await read(readerV1({ scope: () => fail }));
    assert.equal(
      result.scopes.every((scope) => scope.verdict === 'not_established' && scope.policyId === null),
      true,
    );
  });

  test('with no wallet there is nothing to check, and nothing is claimed', async () => {
    const result = await read(readerV1({}), { wallet: 'not-an-address' });
    assert.equal(
      result.scopes.every((scope) => scope.verdict === 'not_established'),
      true,
    );
    assert.match(byScope(result, 'transfer_sender').reason ?? '', /No wallet address/);
  });

  test('every verdict comes from one block', async () => {
    const blocks = new Set<string>();
    const base = readerV1({});
    const result = await readB20TransferEligibilityV1({
      reader: {
        ...base,
        callMany: async (calls: readonly B20BatchCallV1[]) => {
          for (const call of calls) blocks.add(call.blockTag);
          return base.callMany!(calls);
        },
      } as never,
      tokenAddress: TOKEN,
      wallet: WALLET,
      executor: EXECUTOR,
      blockTag: '0xabc',
    });
    assert.deepEqual([...blocks], ['0xabc']);
    assert.equal(result.blockTag, '0xabc');
  });
});

// ---------------------------------------------------------------------------
// Phase 17.5 — the same evidence, asked as a precondition.
//
// The read above is deliberately not a gate. This is the one function that
// turns it into one, and every case here exists because the natural way to
// write it is wrong: `state !== 'authorized'` refuses every unread policy, and
// checking both wallet scopes refuses a purchase over a rule about sending.
// ---------------------------------------------------------------------------

function eligibilityV1(input: {
  paused?: 'paused' | 'not_paused' | 'not_established';
  sender?: B20EligibilityVerdictV1;
  receiver?: B20EligibilityVerdictV1;
  executor?: B20EligibilityVerdictV1;
}): B20TransferEligibilityV1 {
  const scope = (
    name: 'transfer_sender' | 'transfer_receiver' | 'transfer_executor',
    verdict: B20EligibilityVerdictV1,
  ) => ({
    scope: name,
    subject: B20_ELIGIBILITY_SCOPE_SUBJECT_V1[name],
    account: name === 'transfer_executor' ? null : WALLET,
    verdict,
    policyId: '5',
    policyType: 'blocklist' as const,
    reason: null,
  });
  return {
    tokenAddress: TOKEN,
    wallet: WALLET,
    executor: null,
    blockTag: '0x1234',
    blockNumber: '4660',
    transferPause: { state: input.paused ?? 'not_paused', reason: null },
    scopes: [
      scope('transfer_sender', input.sender ?? 'authorized'),
      scope('transfer_receiver', input.receiver ?? 'authorized'),
      scope('transfer_executor', input.executor ?? 'not_established'),
    ],
  };
}

describe('the issuer transfer policy as a precondition', () => {
  test('a measured denial of the governing scope refuses', () => {
    const sell = b20TransferGateV1({
      eligibility: eligibilityV1({ sender: 'denied' }),
      direction: 'sell',
    });
    assert.equal(sell.state, 'denied');
    assert.equal(sell.cause, 'wallet_not_authorized');
    assert.equal(sell.governingScope, 'transfer_sender');
    assert.equal(b20TransferGateRefusesV1(sell), true);
    // The block travels with the refusal, so somebody can re-read it.
    assert.equal(sell.blockTag, '0x1234');

    const buy = b20TransferGateV1({
      eligibility: eligibilityV1({ receiver: 'denied' }),
      direction: 'buy',
    });
    assert.equal(buy.state, 'denied');
    assert.equal(buy.governingScope, 'transfer_receiver');
  });

  test('only the scope that governs the direction can refuse it', () => {
    // A wallet that may not SEND may still buy: nobody is sending. Refusing
    // here would be refusing on a rule about a transfer that is not happening.
    const buy = b20TransferGateV1({
      eligibility: eligibilityV1({ sender: 'denied', receiver: 'authorized' }),
      direction: 'buy',
    });
    assert.equal(buy.state, 'authorized');
    assert.equal(b20TransferGateRefusesV1(buy), false);

    const sell = b20TransferGateV1({
      eligibility: eligibilityV1({ sender: 'authorized', receiver: 'denied' }),
      direction: 'sell',
    });
    assert.equal(sell.state, 'authorized');
  });

  test('the executor scope can never refuse, because no executor is known here', () => {
    for (const direction of ['buy', 'sell'] as const) {
      const gate = b20TransferGateV1({
        eligibility: eligibilityV1({ executor: 'denied' }),
        direction,
      });
      assert.equal(gate.state, 'authorized');
      assert.equal(b20TransferGateRefusesV1(gate), false);
    }
  });

  test('a pause denies both directions, and names the pause rather than the wallet', () => {
    for (const direction of ['buy', 'sell'] as const) {
      const gate = b20TransferGateV1({
        eligibility: eligibilityV1({ paused: 'paused' }),
        direction,
      });
      assert.equal(gate.state, 'denied');
      assert.equal(gate.cause, 'transfers_paused');
      // The reader is not told this is about them.
      assert.match(gate.detail, /not a statement about you/);
    }
  });

  test('nothing that failed to answer is ever a denial', () => {
    // Every shape of "we did not learn it": no read at all, a read whose pause
    // flag never arrived, a scope the token would not name, and a scope that is
    // simply absent from the answer.
    const unreadPause = eligibilityV1({ paused: 'not_established', sender: 'authorized' });
    const unreadScope = eligibilityV1({ sender: 'not_established' });
    const missingScope: B20TransferEligibilityV1 = {
      ...eligibilityV1({}),
      scopes: [],
    };
    for (const eligibility of [null, undefined, unreadScope, missingScope]) {
      const gate = b20TransferGateV1({ eligibility, direction: 'sell' });
      assert.equal(gate.state, 'not_established');
      assert.equal(gate.cause, null);
      assert.equal(b20TransferGateRefusesV1(gate), false);
    }
    // An unread pause beside an authorized wallet is authorized, not denied:
    // unread is not paused, in the direction that matters here.
    assert.equal(b20TransferGateV1({ eligibility: unreadPause, direction: 'sell' }).state, 'authorized');
  });

  test('every state carries a sentence, and a refusal names the issuer as its author', () => {
    const cases = [
      b20TransferGateV1({ eligibility: null, direction: 'buy' }),
      b20TransferGateV1({ eligibility: eligibilityV1({}), direction: 'buy' }),
      b20TransferGateV1({ eligibility: eligibilityV1({ receiver: 'denied' }), direction: 'buy' }),
    ];
    for (const gate of cases) {
      assert.ok(gate.detail.length > 40, 'a verdict with no explanation cannot be checked');
      // Never a provider, an endpoint or a key — the standing rule for evidence.
      assert.doesNotMatch(gate.detail, /https?:|rpc|api[_-]?key/i);
    }
    // A refusal must not read as Miorail's judgement about the person.
    assert.match(cases[2]!.detail, /issuer/i);
    assert.match(cases[2]!.detail, /Miorail does not set it/);
  });
});
