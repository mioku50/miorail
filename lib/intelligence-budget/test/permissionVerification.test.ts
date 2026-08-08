import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  PERMISSION_REFUSAL_COPY_V1,
  verifyPermissionBindingV1,
  verifyPermissionStatusV1,
  verifySpendPermissionV1,
  type ExpectedPermissionBindingV1,
  type OnchainPermissionStatusV1,
  type PermissionRefusalV1,
  type SpendPermissionClaimV1,
} from '../src/permissionVerification.js';

// ---------------------------------------------------------------------------
// T71 §10 — the tests that make "no DB-only fake permission" structural.
//
// The attack this file exists for is dull and completely effective: POST a
// well-formed permission object naming somebody else's wallet, or your own
// wallet with a spender you control, or a hash belonging to a permission you
// did not grant — and walk away with a server-side budget the chain will never
// honour, or worse, one bound to a permission somebody else pays for.
//
// Every check below is an equality against a value the caller cannot supply.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HASH = `0x${'ab'.repeat(32)}`;
const NOW = new Date('2026-08-04T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

/** 3.00 USDC monthly, the product default. */
const MONTHLY_ATOMIC = '3000000';

function claim(overrides: Partial<SpendPermissionClaimV1['permission']> = {}, top: Partial<SpendPermissionClaimV1> = {}): SpendPermissionClaimV1 {
  return {
    signature: `0x${'cd'.repeat(65)}`,
    chainId: 8453,
    permissionHash: HASH,
    permission: {
      account: WALLET,
      spender: SPENDER,
      token: USDC,
      allowance: MONTHLY_ATOMIC,
      period: 2_592_000,
      start: NOW_SECONDS - 60,
      end: NOW_SECONDS + 30 * 86_400,
      salt: '1',
      extraData: '0x',
      ...overrides,
    },
    ...top,
  };
}

function expected(overrides: Partial<ExpectedPermissionBindingV1> = {}): ExpectedPermissionBindingV1 {
  return {
    walletAddress: WALLET,
    chainId: 8453,
    token: USDC,
    spender: SPENDER,
    periodLimitAtomic: MONTHLY_ATOMIC,
    minimumPeriodSeconds: 2_592_000,
    now: NOW,
    ...overrides,
  };
}

function status(overrides: Partial<OnchainPermissionStatusV1> = {}): OnchainPermissionStatusV1 {
  return {
    isActive: true,
    // The shape a real Base Account grant arrives in: signed and acceptable to
    // the contract, but not yet written to its storage — the approve is bundled
    // into the first spend. Fixtures that said `isApprovedOnchain: true` here
    // described a state no wallet has ever produced at confirm time, which is
    // exactly why the impossible gate survived review.
    isApprovedOnchain: false,
    signatureAcceptedOnchain: true,
    isRevoked: false,
    isExpired: false,
    remainingSpendAtomic: MONTHLY_ATOMIC,
    ...overrides,
  };
}

function refusalOf(result: ReturnType<typeof verifyPermissionBindingV1>): PermissionRefusalV1 | 'ok' {
  return result.ok ? 'ok' : result.refusal;
}

describe('a well-formed, wallet-signed, on-chain permission is accepted', () => {
  test('the happy path', () => {
    const result = verifySpendPermissionV1({
      claim: claim(),
      expected: expected(),
      derivedHash: HASH,
      status: status(),
    });
    assert.deepEqual(result, { ok: true });
  });

  test('address comparisons are case-insensitive, as addresses are', () => {
    // A checksummed address from the wallet and a lower-cased one from the
    // session are the same address, and refusing that pair would make the
    // feature fail for everybody.
    const result = verifySpendPermissionV1({
      claim: claim({ account: WALLET.toUpperCase().replace('0X', '0x') }),
      expected: expected(),
      derivedHash: HASH,
      status: status(),
    });
    assert.deepEqual(result, { ok: true });
  });
});

describe('§10 — a permission for the wrong anything is refused', () => {
  test('another wallet cannot bind a budget to this session', () => {
    // The wallet comes from the session; the claim is just a claim.
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({
          claim: claim({ account: '0x9999999999999999999999999999999999999999' }),
          expected: expected(),
          derivedHash: HASH,
        }),
      ),
      'wallet_mismatch',
    );
  });

  test('another chain is refused rather than normalised', () => {
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({ claim: claim({}, { chainId: 84532 }), expected: expected(), derivedHash: HASH }),
      ),
      'chain_mismatch',
    );
  });

  test('another token is refused', () => {
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({
          claim: claim({ token: '0x4200000000000000000000000000000000000006' }),
          expected: expected(),
          derivedHash: HASH,
        }),
      ),
      'token_mismatch',
    );
  });

  test('a spender this server does not control is refused', () => {
    // Otherwise a user could grant a permission to an address they own, get a
    // budget, and every paid check would fail at charge time — after the
    // product had already promised the evidence.
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({
          claim: claim({ spender: '0x8888888888888888888888888888888888888888' }),
          expected: expected(),
          derivedHash: HASH,
        }),
      ),
      'spender_mismatch',
    );
  });

  test('a hash the server did not derive is refused', () => {
    // The single most important check here. The hash is the identity every
    // later charge is addressed to; a client that can name it freely can point
    // this budget at a permission somebody else granted and pays for.
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({
          claim: claim({}, { permissionHash: `0x${'ef'.repeat(32)}` }),
          expected: expected(),
          derivedHash: HASH,
        }),
      ),
      'permission_hash_mismatch',
    );
  });

  test('a permission with no signature is refused', () => {
    assert.equal(
      refusalOf(verifyPermissionBindingV1({ claim: claim({}, { signature: '' }), expected: expected(), derivedHash: HASH })),
      'signature_missing',
    );
  });
});

describe('the limits the user chose must be limits the chain will honour', () => {
  test('an allowance below the monthly limit is refused', () => {
    // The product would otherwise promise a ceiling the chain does not have,
    // and the user would find out as a failed check mid-month.
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({
          claim: claim({ allowance: '1000000' }),
          expected: expected(),
          derivedHash: HASH,
        }),
      ),
      'allowance_below_limit',
    );
  });

  test('an allowance above the limit is fine — the budget is the tighter cap', () => {
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({ claim: claim({ allowance: '50000000' }), expected: expected(), derivedHash: HASH }),
      ),
      'ok',
    );
  });

  test('a period shorter than a month is refused', () => {
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({ claim: claim({ period: 86_400 }), expected: expected(), derivedHash: HASH }),
      ),
      'period_too_short',
    );
  });

  test('a permission that has not started, or has ended, is refused', () => {
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({
          claim: claim({ start: NOW_SECONDS + 3600, end: NOW_SECONDS + 90_000 }),
          expected: expected(),
          derivedHash: HASH,
        }),
      ),
      'not_started',
    );
    assert.equal(
      refusalOf(
        verifyPermissionBindingV1({
          claim: claim({ start: NOW_SECONDS - 90_000, end: NOW_SECONDS - 10 }),
          expected: expected(),
          derivedHash: HASH,
        }),
      ),
      'already_expired',
    );
  });
});

describe('§10 — a signature in a POST body is not an on-chain permission', () => {
  test('a signature the contract will not accept creates nothing', () => {
    // Without this, anyone who can reach the endpoint mints themselves a budget
    // out of well-formed JSON. This is the check that makes "no DB-only fake
    // permission" a property rather than a promise.
    assert.equal(
      refusalOf(
        verifyPermissionStatusV1({
          status: status({ isApprovedOnchain: false, signatureAcceptedOnchain: false }),
          periodLimitAtomic: MONTHLY_ATOMIC,
        }),
      ),
      'not_approved_onchain',
    );
  });

  // T71-LIVE-2 — the regression that cost a working feature. Every real grant
  // looks like this, and the old gate refused every one of them.
  test('a freshly signed permission the chain has not stored yet is accepted', () => {
    assert.deepEqual(
      verifyPermissionStatusV1({
        status: status({ isApprovedOnchain: false, signatureAcceptedOnchain: true }),
        periodLimitAtomic: MONTHLY_ATOMIC,
      }),
      { ok: true },
    );
  });

  test('a permission already in the contract storage is still accepted', () => {
    // The state after the first charge has bundled its approve. Both paths must
    // verify, or the second month refuses what the first allowed.
    assert.deepEqual(
      verifyPermissionStatusV1({
        status: status({ isApprovedOnchain: true, signatureAcceptedOnchain: true }),
        periodLimitAtomic: MONTHLY_ATOMIC,
      }),
      { ok: true },
    );
  });

  test('revoked wins over an acceptable signature', () => {
    // A revoked permission can still carry a valid signature — the signature is
    // not what was withdrawn. Order matters, and the user must be told which.
    assert.equal(
      refusalOf(
        verifyPermissionStatusV1({
          status: status({ isRevoked: true, signatureAcceptedOnchain: true }),
          periodLimitAtomic: MONTHLY_ATOMIC,
        }),
      ),
      'permission_revoked',
    );
  });

  test('revoked, expired and inactive are each named separately', () => {
    assert.equal(
      refusalOf(verifyPermissionStatusV1({ status: status({ isRevoked: true }), periodLimitAtomic: MONTHLY_ATOMIC })),
      'permission_revoked',
    );
    assert.equal(
      refusalOf(verifyPermissionStatusV1({ status: status({ isExpired: true }), periodLimitAtomic: MONTHLY_ATOMIC })),
      'already_expired',
    );
    assert.equal(
      refusalOf(verifyPermissionStatusV1({ status: status({ isActive: false }), periodLimitAtomic: MONTHLY_ATOMIC })),
      'permission_inactive',
    );
  });

  test('a period with less left than the limit is refused', () => {
    assert.equal(
      refusalOf(
        verifyPermissionStatusV1({
          status: status({ remainingSpendAtomic: '500000' }),
          periodLimitAtomic: MONTHLY_ATOMIC,
        }),
      ),
      'remaining_below_limit',
    );
  });

  test('binding is checked before the chain is', () => {
    // A claim for the wrong wallet must never reach an RPC endpoint: it costs a
    // metered call to learn something the session already knew.
    const result = verifySpendPermissionV1({
      claim: claim({ account: '0x9999999999999999999999999999999999999999' }),
      expected: expected(),
      derivedHash: HASH,
      // Would pass on its own, and must not be reached.
      status: status(),
    });
    assert.equal(refusalOf(result), 'wallet_mismatch');
  });
});

describe('every refusal is fail-closed and explainable', () => {
  test('malformed input is refused, never coerced', () => {
    for (const broken of [
      { account: 'not-an-address' },
      { spender: '0x123' },
      { token: '' },
      { allowance: '-1' },
      { allowance: '3.5' },
      { period: 0 },
      { period: 1.5 },
      { end: NOW_SECONDS - 90_000, start: NOW_SECONDS - 60 },
    ]) {
      const result = verifyPermissionBindingV1({
        claim: claim(broken as never),
        expected: expected(),
        derivedHash: HASH,
      });
      assert.equal(result.ok, false, `${JSON.stringify(broken)} was accepted`);
    }
  });

  test('every refusal has copy, and none of it leaks a value', () => {
    const refusals: PermissionRefusalV1[] = [
      'malformed_permission',
      'signature_missing',
      'permission_hash_mismatch',
      'wallet_mismatch',
      'chain_mismatch',
      'token_mismatch',
      'spender_mismatch',
      'allowance_below_limit',
      'period_too_short',
      'not_started',
      'already_expired',
      'not_approved_onchain',
      'permission_revoked',
      'permission_inactive',
      'remaining_below_limit',
    ];
    for (const refusal of refusals) {
      const copy = PERMISSION_REFUSAL_COPY_V1[refusal];
      assert.ok(copy && copy.length > 20, `${refusal} has no sentence`);
      // No address, no URL, no key material — a refusal is read by a user, and
      // a copied error message ends up in a support channel.
      assert.ok(!/0x[0-9a-fA-F]{8}/.test(copy), `${refusal} leaks an address`);
      assert.ok(!/https?:\/\//.test(copy), `${refusal} leaks a URL`);
    }
  });

  test('§10 — free route comparison is never implicated', () => {
    // Whatever went wrong with a permission, comparing routes still works, and
    // the copy for the states a user is likeliest to hit says so.
    for (const refusal of ['not_approved_onchain', 'spender_mismatch', 'signature_missing'] as const) {
      assert.match(
        PERMISSION_REFUSAL_COPY_V1[refusal],
        /nothing was (stored|charged)|unaffected/i,
        `${refusal} does not say what survived`,
      );
    }
  });

  test('the module reaches no wallet, no SDK and no network', () => {
    // The same boundary spendPermissionCharger.ts documents: this package never
    // imports @base-org/account, viem, wagmi or react, so the on-chain status
    // has to be handed in and cannot be quietly fetched.
    const text = readFileSync(new URL('../src/permissionVerification.ts', import.meta.url), 'utf8');
    // Comments may NAME the boundary they exist to explain; code may not cross
    // it. Checking the raw text failed on the header comment that documents
    // exactly this rule — the same trap a guard in T69-A fell into.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(imports, [], 'permissionVerification.ts imports something');
    for (const banned of ['fetch(', 'Date.now()', 'process.env', 'require(']) {
      assert.ok(!code.includes(banned), `permissionVerification.ts reaches ${banned}`);
    }
  });
});
