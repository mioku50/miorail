import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_POLICY_REGISTRY_V1,
  B20_SEIZE_PAUSE_ORDINAL_V1,
  B20_SEIZE_SELECTORS_V1,
  B20_SELECTORS_V1,
  readB20SeizeConfigurationV1,
  type B20BatchCallV1,
  type B20ReaderV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Administrative seizure, and the inversion at the centre of it.
//
// `SEIZE_EXEMPT_POLICY` is an EXEMPTION: an account the policy AUTHORIZES is
// the one that cannot be taken from. Every other policy slot in this codebase
// reads the other way round, so the sentence that is correct everywhere else
// is exactly backwards here — and getting it backwards tells a holder the
// opposite of the truth about their own balance.
//
// An unset slot is always-allow, which authorizes everybody, which means NOBODY
// is seizable. So the default state of a token is "seize does nothing", and a
// surface that read the slot as an ordinary allowlist would announce the
// opposite of that too.
// ---------------------------------------------------------------------------

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const HOLDER = '0x1111111111111111111111111111111111111111';
const TREASURY = '0x2222222222222222222222222222222222222222';
const EXEMPT_KEY = `0x${'e1'.repeat(32)}`;
const RECEIVER_KEY = `0x${'r1'.replace('r', 'a').repeat(32)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const ok = (value: string) => ({ ok: true as const, value });
const reverted = { ok: false as const, reason: 'reverted' as const };

/** Answers by selector, so a test states what the chain says rather than the
 * order the implementation happens to ask in. */
function readerV1(input: {
  exemptKey?: unknown;
  receiverKey?: unknown;
  exemptPolicyId?: bigint;
  receiverPolicyId?: bigint;
  exists?: (policyId: bigint) => unknown;
  authorized?: (policyId: bigint, account: string) => unknown;
  paused?: unknown;
}): B20ReaderV1 {
  const answer = (call: { to: string; data: string }) => {
    if (call.to.toLowerCase() === B20_POLICY_REGISTRY_V1) {
      const policyId = BigInt(`0x${call.data.slice(10, 74)}`);
      if (call.data.startsWith(`0x${B20_SELECTORS_V1.policyExists}`)) {
        return input.exists?.(policyId) ?? ok(word(1n));
      }
      const account = `0x${call.data.slice(-40)}`;
      return input.authorized?.(policyId, account) ?? ok(word(0n));
    }
    if (call.data.startsWith(`0x${B20_SEIZE_SELECTORS_V1.seizeExemptPolicy}`)) {
      return input.exemptKey ?? ok(EXEMPT_KEY);
    }
    if (call.data.startsWith(`0x${B20_SEIZE_SELECTORS_V1.seizeReceiverPolicy}`)) {
      return input.receiverKey ?? ok(RECEIVER_KEY);
    }
    if (call.data.startsWith(`0x${B20_SELECTORS_V1.isPaused}`)) {
      return input.paused ?? ok(word(0n));
    }
    if (call.data.startsWith(`0x${B20_SELECTORS_V1.policyId}`)) {
      const key = `0x${call.data.slice(10, 74)}`;
      return key === EXEMPT_KEY
        ? ok(word(input.exemptPolicyId ?? 7n))
        : ok(word(input.receiverPolicyId ?? 8n));
    }
    return reverted;
  };
  return {
    readBlockAnchor: async () => ({ ok: true, value: { blockTag: '0x1', blockNumber: 1n } }),
    call: async (call: B20BatchCallV1) => answer(call),
    callMany: async (calls: readonly B20BatchCallV1[]) => calls.map((call) => answer(call)),
  } as never;
}

const read = (reader: B20ReaderV1, extra: { holder?: string; receiver?: string } = {}) =>
  readB20SeizeConfigurationV1({
    reader,
    tokenAddress: TOKEN,
    blockTag: '0x1',
    holder: extra.holder ?? HOLDER,
    receiver: extra.receiver ?? TREASURY,
  });

describe('whether the issuer can take a balance', () => {
  test('authorized by the exemption policy means EXEMPT, not allowed', async () => {
    // The inversion, stated as an assertion. `isAuthorized` answering true here
    // is the holder being protected, and calling that "authorized" on a screen
    // would be the exact opposite of what it means.
    const result = await read(readerV1({ authorized: () => ok(word(1n)) }));
    assert.equal(result.holder?.outcome, 'exempt');
    assert.notEqual(result.holder?.outcome, 'seizable');
    // The receiver gate is ordinary polarity, in the same read, on the same
    // answer. One true, two meanings.
    assert.equal(result.receiver?.outcome, 'permitted');
  });

  test('not authorized by the exemption policy is the address that can be seized', async () => {
    const result = await read(readerV1({ authorized: () => ok(word(0n)) }));
    assert.equal(result.holder?.outcome, 'seizable');
    assert.equal(result.receiver?.outcome, 'refused');
  });

  test('an unset exemption slot means nobody is seizable', async () => {
    // ALWAYS_ALLOW exempts everybody, which is the documented "seize does
    // nothing" state and the state every token is in until an issuer leaves it.
    const result = await read(readerV1({ exemptPolicyId: 0n, authorized: () => ok(word(1n)) }));
    assert.equal(result.arming, 'unconfigured');
    assert.equal(result.holder?.outcome, 'exempt');
  });

  test('a policy the registry never had does not arm anything', async () => {
    // `isAuthorized` answers true for a policy that does not exist, and true on
    // this slot means exempt — so without the existence read a phantom policy
    // would read as protection nobody configured.
    const result = await read(readerV1({ exists: () => ok(word(0n)) }));
    assert.equal(result.arming, 'unconfigured');
    assert.equal(result.holder?.outcome, 'not_established');
    assert.match(result.exemptPolicy.reason ?? '', /not in the registry/i);
  });

  test('a configured exemption policy is armed, and that is not a verdict about anyone', async () => {
    const result = await read(readerV1({}));
    assert.equal(result.arming, 'armed');
    // Armed says a seizable set EXISTS. Which addresses are in it is the
    // separate, per-address answer beside it, and the two are never merged.
    assert.equal(result.holder?.outcome, 'seizable');
    assert.equal(result.exemptPolicy.policyId, '7');
    assert.equal(result.receiverPolicy.policyId, '8');
  });
});

describe('what this deployment actually carries', () => {
  test('a token that reverts the getter does not have seize, and that is not our failure', async () => {
    // Before Cobalt this is every token. The precompile echoes an unknown
    // function's own selector, and reporting that as a failed read would put
    // our outage on the asset's record.
    const result = await read(
      readerV1({
        exemptKey: {
          ok: false as const,
          reason: 'reverted' as const,
          revertSelector: `0x${B20_SEIZE_SELECTORS_V1.seizeExemptPolicy}`,
        },
      }),
    );
    assert.equal(result.surface, 'not_on_this_deployment');
    assert.equal(result.arming, 'not_established');
    assert.equal(result.holder, null);
    assert.match(result.exemptPolicy.reason ?? '', /does not carry the seize surface/i);
  });

  test('an endpoint that did not answer is not a token without seize', async () => {
    const result = await read(
      readerV1({ exemptKey: { ok: false as const, reason: 'transport' as const } }),
    );
    assert.equal(result.surface, 'not_established');
    assert.notEqual(result.surface, 'not_on_this_deployment');
  });

  test('the seize pause is its own bit, read at ordinal 3', async () => {
    const seen: bigint[] = [];
    const base = readerV1({ paused: ok(word(1n)) });
    const inner = base.callMany!.bind(base);
    const spy = {
      ...base,
      callMany: async (calls: readonly B20BatchCallV1[]) => {
        for (const call of calls) {
          if (call.data.startsWith(`0x${B20_SELECTORS_V1.isPaused}`)) {
            seen.push(BigInt(`0x${call.data.slice(10)}`));
          }
        }
        return inner(calls);
      },
    } as never as B20ReaderV1;
    const result = await read(spy);
    assert.equal(result.pause, 'paused');
    // Pausing BURN does not stop a seizure and pausing SEIZE does not stop a
    // burn, so reading the wrong ordinal answers a different question.
    assert.deepEqual(seen, [B20_SEIZE_PAUSE_ORDINAL_V1]);
    assert.equal(B20_SEIZE_PAUSE_ORDINAL_V1, 3n);
  });

  test('an unread pause is not an unpaused contract', async () => {
    const result = await read(readerV1({ paused: { ok: false as const, reason: 'transport' as const } }));
    assert.equal(result.pause, 'not_established');
  });

  test('no address supplied is no address answered, and never a blank verdict', async () => {
    const result = await readB20SeizeConfigurationV1({
      reader: readerV1({}),
      tokenAddress: TOKEN,
      blockTag: '0x1',
    });
    assert.equal(result.holder, null);
    assert.equal(result.receiver, null);
    // The configuration is still readable without anybody to ask about.
    assert.equal(result.arming, 'armed');
  });
});
