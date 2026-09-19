import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_ELIGIBILITY_SCOPE_SUBJECT_V1,
  B20_POLICY_REGISTRY_V1,
  type B20BatchCallV1,
  B20_SELECTORS_V1,
  b20ExecutorFromApprovalV1,
  b20ExecutorGateRefusesV1,
  b20ExecutorGateV1,
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
  /** Whether the registry has the policy at all. Defaults to yes, because a
   * token naming a policy that exists is the ordinary case and every test
   * about a VERDICT wants to get past this read to reach it. */
  exists?: (data: string) => unknown;
  paused?: unknown;
}): B20ReaderV1 {
  let scopeIndex = 0;
  const answer = (call: { to: string; data: string }) => {
    if (call.to.toLowerCase() === B20_POLICY_REGISTRY_V1) {
      // Two different questions reach the registry, and answering them from one
      // branch is how a `denied` fixture would silently start reading "no such
      // policy" instead.
      if (call.data.startsWith(`0x${B20_SELECTORS_V1.policyExists}`)) {
        return input.exists?.(call.data) ?? ok(word(1n));
      }
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

// ---------------------------------------------------------------------------
// The executor gate: the same question, one step later, with an address.
// ---------------------------------------------------------------------------

const ROUTER_V1 = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const OTHER_ROUTER_V1 = '0x1111111111111111111111111111111111111111';
const USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function approveCallV1(to: string, spender: string) {
  return { to, data: `0x095ea7b3${'0'.repeat(24)}${spender.slice(2)}${'f'.repeat(64)}` };
}

function executorEligibilityV1(input: {
  executor: string | null;
  verdict?: B20EligibilityVerdictV1;
}): B20TransferEligibilityV1 {
  const base = eligibilityV1({ executor: input.verdict ?? 'authorized' });
  return {
    ...base,
    executor: input.executor,
    scopes: base.scopes.map((scope) =>
      scope.scope === 'transfer_executor' ? { ...scope, account: input.executor } : scope,
    ),
  };
}

describe('the contract that will move the token', () => {
  test('the executor is the spender of the approval on the reviewed token', () => {
    const executor = b20ExecutorFromApprovalV1({
      tokenAddress: TOKEN,
      calls: [approveCallV1(TOKEN, ROUTER_V1), { to: ROUTER_V1, data: '0xdeadbeef' }],
    });
    assert.equal(executor, ROUTER_V1);
  });

  test('a buy approves the cash asset, so it establishes no executor at all', () => {
    // The contract that DELIVERS the token is not named anywhere in the batch.
    // Guessing the swap target would answer a different question under this
    // label — the same error as reading a router's verdict as the wallet's.
    assert.equal(
      b20ExecutorFromApprovalV1({
        tokenAddress: TOKEN,
        calls: [approveCallV1(USDC_V1, ROUTER_V1), { to: ROUTER_V1, data: '0xdeadbeef' }],
      }),
      null,
    );
  });

  test('two spenders in one batch are not one verdict', () => {
    assert.equal(
      b20ExecutorFromApprovalV1({
        tokenAddress: TOKEN,
        calls: [approveCallV1(TOKEN, ROUTER_V1), approveCallV1(TOKEN, OTHER_ROUTER_V1)],
      }),
      null,
    );
  });

  test('a call that is not an approval, or is the wrong length, names nobody', () => {
    assert.equal(
      b20ExecutorFromApprovalV1({ tokenAddress: TOKEN, calls: [{ to: TOKEN, data: '0x095ea7b3' }] }),
      null,
    );
    assert.equal(
      b20ExecutorFromApprovalV1({ tokenAddress: TOKEN, calls: [{ to: TOKEN, data: '0xa9059cbb' }] }),
      null,
    );
    assert.equal(b20ExecutorFromApprovalV1({ tokenAddress: TOKEN, calls: [] }), null);
  });

  test('a measured denial of the executor refuses the release', () => {
    const gate = b20ExecutorGateV1({
      eligibility: executorEligibilityV1({ executor: ROUTER_V1, verdict: 'denied' }),
    });
    assert.equal(gate.state, 'denied');
    assert.equal(gate.cause, 'executor_not_authorized');
    assert.equal(gate.executor, ROUTER_V1);
    assert.equal(gate.blockTag, '0x1234');
    assert.equal(b20ExecutorGateRefusesV1(gate), true);
  });

  test('an unread policy, an absent read and an unknown executor all fail open', () => {
    const cases = [
      b20ExecutorGateV1({ eligibility: null }),
      b20ExecutorGateV1({
        eligibility: executorEligibilityV1({ executor: ROUTER_V1, verdict: 'not_established' }),
      }),
      // Authorized about nobody is not an authorisation. This is the shape the
      // confirm-step read has always produced, and it must not become a pass.
      b20ExecutorGateV1({ eligibility: executorEligibilityV1({ executor: null }) }),
    ];
    for (const gate of cases) {
      assert.equal(gate.state, 'not_established');
      assert.equal(b20ExecutorGateRefusesV1(gate), false);
      assert.equal(gate.cause, null);
    }
  });

  test('a wallet verdict can never become the executor verdict', () => {
    // sender and receiver denied, executor authorized: this gate is about the
    // contract, and the wallet's own rules were already decided at confirm.
    const eligibility = {
      ...executorEligibilityV1({ executor: ROUTER_V1, verdict: 'authorized' }),
    };
    eligibility.scopes = eligibility.scopes.map((scope) =>
      scope.scope === 'transfer_executor' ? scope : { ...scope, verdict: 'denied' as const },
    );
    assert.equal(b20ExecutorGateV1({ eligibility }).state, 'authorized');
  });

  test('every executor sentence names the issuer and carries no endpoint', () => {
    const cases = [
      b20ExecutorGateV1({ eligibility: null }),
      b20ExecutorGateV1({ eligibility: executorEligibilityV1({ executor: ROUTER_V1 }) }),
      b20ExecutorGateV1({
        eligibility: executorEligibilityV1({ executor: ROUTER_V1, verdict: 'denied' }),
      }),
    ];
    for (const gate of cases) {
      assert.ok(gate.detail.length > 40);
      assert.doesNotMatch(gate.detail, /https?:|rpc|api[_-]?key/i);
    }
    assert.match(cases[2]!.detail, /issuer/i);
    assert.match(cases[2]!.detail, /Miorail does not set it/);
    // The fact a reader turns into a false one, written where it applies.
    assert.match(cases[0]!.detail, /approval is not policy gated/i);
  });
});

// ---------------------------------------------------------------------------
// A policy the registry does not have.
//
// MEASURED on Base mainnet 2026-09-18: of policy ids 1 through 6, only 2 and 5
// exist — and all six answer `isAuthorized` with `true`. Both built-in
// sentinels are real rows: `policyExists(0)` and `policyExists((1 << 56) | 1)`
// both answer `true`, so an unrestricted token is not caught by this.
//
// Cobalt (2026-09-30) makes it worse and says so: an INTERSECT id that was
// never created has no children and returns `true` for everyone.
// ---------------------------------------------------------------------------

describe('a policy the registry does not have', () => {
  test('a phantom policy is not an allowance, however loudly isAuthorized agrees', async () => {
    const result = await read(
      readerV1({ exists: () => ok(word(0n)), authorized: () => ok(word(1n)) }),
    );
    const sender = byScope(result, 'transfer_sender');
    assert.equal(sender.verdict, 'not_established');
    assert.match(sender.reason ?? '', /not in the registry/i);
    // The policy id is still reported: the token DID name one, and which one is
    // the operator's first question.
    assert.equal(sender.policyId, '5');
  });

  test('it refuses nothing — the gate only ever refuses a measured denial', async () => {
    const eligibility = await read(
      readerV1({ exists: () => ok(word(0n)), authorized: () => ok(word(1n)) }),
      { executor: EXECUTOR },
    );
    const gate = b20ExecutorGateV1({ eligibility });
    assert.equal(gate.state, 'not_established');
    assert.equal(b20ExecutorGateRefusesV1(gate), false);
  });

  test('an unreadable existence answer is not an allowance either', async () => {
    const result = await read(readerV1({ exists: () => fail, authorized: () => ok(word(1n)) }));
    const sender = byScope(result, 'transfer_sender');
    assert.equal(sender.verdict, 'not_established');
    assert.match(sender.reason ?? '', /whether that policy exists/i);
  });

  test('a policy that does exist still reaches its verdict, in both directions', async () => {
    const allowed = await read(readerV1({ exists: () => ok(word(1n)), authorized: () => ok(word(1n)) }));
    const denied = await read(readerV1({ exists: () => ok(word(1n)), authorized: () => ok(word(0n)) }));
    assert.equal(byScope(allowed, 'transfer_sender').verdict, 'authorized');
    assert.equal(byScope(denied, 'transfer_sender').verdict, 'denied');
  });

  test('the existence question is asked at the same block as the verdict', async () => {
    const blocks: string[] = [];
    const base = readerV1({});
    const inner = base.callMany!.bind(base);
    const spy = {
      ...base,
      callMany: async (calls: readonly B20BatchCallV1[]) => {
        for (const call of calls) {
          if (call.to.toLowerCase() === B20_POLICY_REGISTRY_V1) blocks.push(call.blockTag);
        }
        return inner(calls);
      },
    } as never as B20ReaderV1;
    await read(spy);
    assert.ok(blocks.length >= 2);
    assert.equal(new Set(blocks).size, 1, 'two facts from two blocks are two facts');
  });
});

describe('the two ways nothing was established', () => {
  test('a phantom policy and an unanswered registry do not share a sentence', async () => {
    const phantom = b20ExecutorGateV1({
      eligibility: await read(
        readerV1({ exists: () => ok(word(0n)), authorized: () => ok(word(1n)) }),
        { executor: EXECUTOR },
      ),
    });
    const silent = b20ExecutorGateV1({
      eligibility: await read(readerV1({ authorized: () => fail }), { executor: EXECUTOR }),
    });
    assert.equal(phantom.state, 'not_established');
    assert.equal(silent.state, 'not_established');
    // Same state, different facts. An operator reading "nobody answered" when
    // the truth is "there is nothing there to answer" would go looking for an
    // outage that does not exist.
    assert.notEqual(phantom.detail, silent.detail);
    assert.match(phantom.detail, /not in the registry/i);
    assert.match(silent.detail, /did not answer/i);
    // Neither is ever a claim that the address passed.
    for (const gate of [phantom, silent]) {
      assert.equal(b20ExecutorGateRefusesV1(gate), false);
      assert.match(gate.detail, /nothing is claimed either/);
      assert.doesNotMatch(gate.detail, /allowed|permitted|cleared/i);
    }
  });

  test('every detail fits the field the MCP publishes it in', async () => {
    // `executorPolicy.detail` is capped at 600 characters on the private MCP
    // output. A sentence that grew past it would fail the response schema at
    // release time, which is the worst possible moment to find out.
    const gates = [
      b20ExecutorGateV1({ eligibility: null }),
      b20ExecutorGateV1({
        eligibility: await read(readerV1({ exists: () => ok(word(0n)) }), { executor: EXECUTOR }),
      }),
      b20ExecutorGateV1({
        eligibility: await read(readerV1({ authorized: () => fail }), { executor: EXECUTOR }),
      }),
      b20ExecutorGateV1({
        eligibility: await read(readerV1({}), { executor: EXECUTOR }),
      }),
    ];
    for (const gate of gates) {
      assert.ok(gate.detail.length <= 600, `${gate.detail.length} characters`);
      assert.doesNotMatch(gate.detail, /https?:|rpc|api[_-]?key/i);
    }
  });
});
