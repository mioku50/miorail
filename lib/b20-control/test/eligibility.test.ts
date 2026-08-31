import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_POLICY_REGISTRY_V1,
  type B20BatchCallV1,
  B20_SELECTORS_V1,
  readB20TransferEligibilityV1,
  type B20ReaderV1,
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
