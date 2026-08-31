import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_POLICY_REGISTRY_V1,
  type B20BatchCallV1,
  B20_SELECTORS_V1,
  b20TransferEligibilityNoticeV1,
  readB20TransferEligibilityV1,
  type B20ReaderV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Can this wallet move this token.
//
// Measured on Base 2026-08-31: NVDAc and AAPLc both point every transfer scope
// at policy id 5, whose type byte is 0x00 — a live BLOCKLIST, not ALWAYS_ALLOW.
// `isAuthorized` is documented never to revert, and did not: ALWAYS_ALLOW
// authorized every wallet tried, ALWAYS_BLOCK denied, an absent blocklist
// authorized and an absent allowlist denied.
// ---------------------------------------------------------------------------

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const WALLET = '0x1111111111111111111111111111111111111111';
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
}): B20ReaderV1 {
  let scopeIndex = 0;
  const answer = (call: { to: string; data: string }) => {
    if (call.to.toLowerCase() === B20_POLICY_REGISTRY_V1) {
      return input.authorized?.(call.data) ?? ok(word(1n));
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

const read = (reader: B20ReaderV1, wallet = WALLET) =>
  readB20TransferEligibilityV1({ reader, tokenAddress: TOKEN, wallet, blockTag: '0x1' });

describe('whether a wallet may move a B20', () => {
  test('a live blocklist that authorizes this wallet reads as authorized on both scopes', async () => {
    const result = await read(readerV1({}));
    assert.deepEqual(
      result.scopes.map((scope) => [scope.scope, scope.verdict, scope.policyId, scope.policyType]),
      [
        ['transfer_sender', 'authorized', '5', 'blocklist'],
        ['transfer_receiver', 'authorized', '5', 'blocklist'],
      ],
    );
    assert.equal(b20TransferEligibilityNoticeV1(result)?.verdict, 'authorized');
  });

  test('a denial is reported as a denial, and names which side it applies to', async () => {
    const result = await read(
      // Deny only the receiving side, which a blocklist can do independently.
      readerV1({
        authorized: (data) => ok(word(data.endsWith(WALLET.slice(2).toLowerCase()) ? 0n : 1n)),
      }),
    );
    assert.equal(
      result.scopes.every((scope) => scope.verdict === 'denied'),
      true,
    );
    const notice = b20TransferEligibilityNoticeV1(result);
    assert.equal(notice?.verdict, 'denied');
    assert.match(notice?.sentence ?? '', /send or receive/);
    // A policy verdict is about this contract. It must never sound like a
    // statement about the market or about the rest of the wallet.
    assert.match(notice?.sentence ?? '', /says nothing about the market/);
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
    // The policy was still read, so what IS known is kept.
    assert.equal(result.scopes[0]?.policyId, '5');
    assert.equal(b20TransferEligibilityNoticeV1(result)?.verdict, 'not_established');
  });

  test('sending and receiving stay separate facts', async () => {
    // One scope answering and the other failing must not collapse into a single
    // verdict, in either direction.
    let seen = 0;
    const result = await read(
      readerV1({
        authorized: () => {
          seen += 1;
          return seen === 1 ? ok(word(1n)) : fail;
        },
      }),
    );
    assert.equal(result.scopes[0]?.verdict, 'authorized');
    assert.equal(result.scopes[1]?.verdict, 'not_established');
    // Not every scope resolved, so no reassuring headline is emitted.
    assert.notEqual(b20TransferEligibilityNoticeV1(result)?.verdict, 'authorized');
  });

  test('a token that will not name a scope is unresolved, not open', async () => {
    const result = await read(readerV1({ scope: () => fail }));
    assert.equal(
      result.scopes.every((scope) => scope.verdict === 'not_established' && scope.policyId === null),
      true,
    );
  });

  test('with no wallet there is nothing to check, and nothing is claimed', async () => {
    const result = await read(readerV1({}), 'not-an-address');
    assert.equal(
      result.scopes.every((scope) => scope.verdict === 'not_established'),
      true,
    );
    assert.match(b20TransferEligibilityNoticeV1(result)?.sentence ?? '', /No wallet address/);
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
      blockTag: '0xabc',
    });
    assert.deepEqual([...blocks], ['0xabc']);
    assert.equal(result.blockTag, '0xabc');
  });
});
