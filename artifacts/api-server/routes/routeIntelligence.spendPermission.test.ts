import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import { InMemorySpendPermissionRepository } from '@mioagent/autonomy';
import { hashIntelligenceBudgetV1 } from '@mioagent/intelligence-budget';
import { ZERO_HASH_V1 } from '@mioagent/route-domain';
import {
  routeIntelligenceRouter,
  budgetRouteRuntime,
  spendPermissionRouteRuntime,
} from './routeIntelligence.js';
import { PermissionStatusUnavailableError } from '../lib/spendPermissionVerifier.js';

// ---------------------------------------------------------------------------
// T71 — the onboarding flow, tested from the outside.
//
// The tests that matter are the ones where the CLIENT LIES. Prepare tells it
// what to ask for; nothing stops it asking for something else and posting the
// result. Every one of those attempts has to end with no budget and no
// permission record — and the refusal has to name which binding failed, because
// "invalid" would send a user to check the wrong thing.
//
// The verifier is stubbed, which is the only way to test this without Base.
// What is NOT stubbed is the decision: `verifySpendPermissionV1` runs for real,
// against the server's own expected values.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SPENDER = '0x9999999999999999999999999999999999999999';
const NOW = new Date('2026-08-08T09:00:00.000Z');
const DERIVED_HASH = `0x${'ab'.repeat(32)}`;

const originalRuntime = { ...budgetRouteRuntime };
const originalSpendRuntime = { ...spendPermissionRouteRuntime };
const originalChainEnv = process.env.CHAIN_ENV;
const originalPaidFlag = process.env.MIORAIL_PAID_INTELLIGENCE;
const originalRouteFlag = process.env.MIORAIL_ROUTE_INTELLIGENCE_V1;

let repository: InMemoryRouteStorageRepository;
let permissions: InMemorySpendPermissionRepository;
/** What the stubbed chain says. Each test bends exactly one thing. */
let onchain = {
  isActive: true,
  isApprovedOnchain: true,
  isRevoked: false,
  isExpired: false,
  remainingSpendAtomic: '3000000',
};
let derivedHash = DERIVED_HASH;
let statusThrows = false;

function routeApp(user: typeof USER | null = USER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  app.use('/api/route-intelligence', routeIntelligenceRouter);
  return app;
}

/**
 * A permission exactly as a compliant wallet would return it.
 *
 * Two override bags, because the claim has two levels and the difference
 * matters: `inner` bends what was signed, `outer` bends what wraps it.
 */
function grantedPermission(
  inner: Record<string, unknown> = {},
  outer: Record<string, unknown> = {},
) {
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  return {
    signature: `0x${'cd'.repeat(65)}`,
    chainId: 8453,
    permissionHash: DERIVED_HASH,
    permission: {
      account: WALLET,
      spender: SPENDER,
      token: USDC,
      allowance: '3000000',
      period: 30 * 24 * 60 * 60,
      start: nowSeconds - 60,
      end: nowSeconds + 60 * 60 * 24 * 60,
      salt: '12345',
      extraData: '0x',
      ...inner,
    },
    ...outer,
  };
}

const confirmBody = (
  inner: Record<string, unknown> = {},
  outer: Record<string, unknown> = {},
) => ({
  permission: grantedPermission(inner, outer),
  periodLimitUsdc: '3.00',
  maxPerCallUsdc: '0.02',
});

const confirm = (body: unknown, app = routeApp()) =>
  request(app).post('/api/route-intelligence/intelligence-budget/permission/confirm').send(body as object);

beforeEach(() => {
  repository = new InMemoryRouteStorageRepository();
  permissions = new InMemorySpendPermissionRepository();
  onchain = {
    isActive: true,
    isApprovedOnchain: true,
    isRevoked: false,
    isExpired: false,
    remainingSpendAtomic: '3000000',
  };
  derivedHash = DERIVED_HASH;
  statusThrows = false;

  process.env.CHAIN_ENV = 'mainnet';
  process.env.MIORAIL_ROUTE_INTELLIGENCE_V1 = 'true';
  process.env.MIORAIL_PAID_INTELLIGENCE = 'true';

  budgetRouteRuntime.repository = () => repository;
  budgetRouteRuntime.migrationAvailable = async () => true;
  budgetRouteRuntime.now = () => NOW;

  spendPermissionRouteRuntime.permissions = () => permissions;
  spendPermissionRouteRuntime.verifier = () => ({
    async spenderAddress() {
      return SPENDER;
    },
    async derivedHash() {
      // Derived from the permission's OWN fields by the chain, never from the
      // hash the client named.
      return derivedHash;
    },
    async status() {
      if (statusThrows) throw new PermissionStatusUnavailableError();
      return onchain;
    },
  });
});

afterEach(() => {
  Object.assign(budgetRouteRuntime, originalRuntime);
  Object.assign(spendPermissionRouteRuntime, originalSpendRuntime);
  if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
  else process.env.CHAIN_ENV = originalChainEnv;
  if (originalPaidFlag === undefined) delete process.env.MIORAIL_PAID_INTELLIGENCE;
  else process.env.MIORAIL_PAID_INTELLIGENCE = originalPaidFlag;
  if (originalRouteFlag === undefined) delete process.env.MIORAIL_ROUTE_INTELLIGENCE_V1;
  else process.env.MIORAIL_ROUTE_INTELLIGENCE_V1 = originalRouteFlag;
});

describe('T71 — prepare says what to ask the wallet for', () => {
  test('every field is the server’s, and the client supplies only limits', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/intelligence-budget/permission/prepare')
      .send({ periodLimitUsdc: '3.00', maxPerCallUsdc: '0.02' });
    assert.equal(response.status, 200);
    assert.equal(response.body.spender, SPENDER);
    assert.equal(response.body.token, USDC);
    assert.equal(response.body.chainId, 8453);
    assert.equal(response.body.account, WALLET);
    // Exactly the monthly ceiling: the smallest grant that can work.
    assert.equal(response.body.allowanceAtomic, '3000000');
    assert.ok(response.body.periodInDays >= 28);
    assert.ok(response.body.consent.some((line: string) => line.includes('3.00 USDC per month')));
  });

  test('a per-request cap above the monthly limit never opens a wallet', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/intelligence-budget/permission/prepare')
      .send({ periodLimitUsdc: '1.00', maxPerCallUsdc: '5.00' });
    assert.equal(response.status, 400);
  });

  test('an unauthenticated caller is refused before a spender is resolved', async () => {
    let resolved = false;
    spendPermissionRouteRuntime.verifier = () => {
      resolved = true;
      return originalSpendRuntime.verifier();
    };
    const response = await request(routeApp(null))
      .post('/api/route-intelligence/intelligence-budget/permission/prepare')
      .send({ periodLimitUsdc: '3.00', maxPerCallUsdc: '0.02' });
    assert.equal(response.status, 401);
    assert.equal(resolved, false);
  });
});

describe('T71 — the full flow ends in an active budget', () => {
  test('a verified permission creates a permission record and a budget', async () => {
    const response = await confirm(confirmBody());
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.outcome, 'activated');
    assert.equal(response.body.budget.status, 'active');
    // The projection normalises decimals, so '3.00' comes back as '3'.
    assert.equal(Number(response.body.budget.monthlyLimitUsdc), 3);
    assert.equal(Number(response.body.budget.maxPerRequestUsdc), 0.02);

    // The permission record's id IS the chain's identity for it.
    const stored = await permissions.getById(DERIVED_HASH.toLowerCase());
    assert.ok(stored, 'no permission record was written');
    assert.equal(stored.userId, USER.id);
    assert.equal(stored.isActive, true);
    assert.equal(response.body.budget.linkedSpendPermissionId, DERIVED_HASH.toLowerCase());
  });

  test('a repeated confirmation is idempotent and does not reset the ledger', async () => {
    await confirm(confirmBody());
    // Something was charged against the permission in between.
    await permissions.incrementSpent(DERIVED_HASH.toLowerCase(), 250000, { txHash: `0x${'11'.repeat(32)}` });
    const spentBefore = (await permissions.getById(DERIVED_HASH.toLowerCase()))!.spent;
    assert.equal(spentBefore, 250000);

    const again = await confirm(confirmBody());
    assert.equal(again.status, 200);
    assert.equal(again.body.outcome, 'activated');
    // The whole trap: `create` is an upsert, so a second confirmation used to
    // reset `spent` to zero and hand the wallet its allowance back.
    assert.equal((await permissions.getById(DERIVED_HASH.toLowerCase()))!.spent, 250000);
  });

  test('a second confirmation creates no second budget', async () => {
    const first = await confirm(confirmBody());
    const again = await confirm(confirmBody());
    assert.equal(again.body.budget.budgetId, first.body.budget.budgetId);
  });
});

describe('T71 — a lying client gets a refusal, never a budget', () => {
  /** Every one of these must leave the server exactly as it found it. */
  async function assertNothingStored(): Promise<void> {
    assert.equal(await permissions.getById(DERIVED_HASH.toLowerCase()), undefined);
    assert.equal(await repository.getLatestIntelligenceBudget(USER.id, WALLET, 8453), null);
  }

  const cases: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ['a permission granted by another wallet', { account: OTHER_WALLET }, {}, 'wallet_mismatch'],
    ['a permission for another token', { token: '0x4200000000000000000000000000000000000006' }, {}, 'token_mismatch'],
    ['a permission naming another spender', { spender: OTHER_WALLET }, {}, 'spender_mismatch'],
    ['a permission on another chain', {}, { chainId: 1 }, 'chain_mismatch'],
    ['an allowance below the monthly limit', { allowance: '1000000' }, {}, 'allowance_below_limit'],
    ['a period that renews faster than monthly', { period: 60 * 60 * 24 }, {}, 'period_too_short'],
  ];

  for (const [name, inner, outer, refusal] of cases) {
    test(`${name} is refused as ${refusal}`, async () => {
      const response = await confirm(confirmBody(inner, outer));
      assert.equal(response.status, 200);
      assert.equal(response.body.outcome, 'refused');
      assert.equal(response.body.refusal, refusal);
      assert.equal(response.body.budget, null);
      assert.equal(response.body.retryable, false);
      await assertNothingStored();
    });
  }

  test('a permission hash the client invented is refused', async () => {
    // The client names one hash; the chain derives another. Believing the
    // client here would let it bind this budget to somebody else's permission,
    // whose fields would all check out because they would be that permission's.
    const response = await confirm(confirmBody());
    assert.equal(response.body.outcome, 'activated');

    // Now the same claim with a hash the chain does not agree with.
    permissions = new InMemorySpendPermissionRepository();
    repository = new InMemoryRouteStorageRepository();
    derivedHash = `0x${'ef'.repeat(32)}`;
    const mismatched = await confirm(confirmBody());
    assert.equal(mismatched.body.outcome, 'refused');
    assert.equal(mismatched.body.refusal, 'permission_hash_mismatch');
    await assertNothingStored();
  });

  test('a permission the chain has never seen is refused, and is retryable', async () => {
    onchain.isApprovedOnchain = false;
    const response = await confirm(confirmBody());
    assert.equal(response.body.outcome, 'refused');
    assert.equal(response.body.refusal, 'not_approved_onchain');
    // A wallet can return a signed permission a moment before the chain has it.
    assert.equal(response.body.retryable, true);
    await assertNothingStored();
  });

  test('a revoked permission is refused', async () => {
    onchain.isRevoked = true;
    const response = await confirm(confirmBody());
    assert.equal(response.body.refusal, 'permission_revoked');
    await assertNothingStored();
  });

  test('an unreachable chain is not an accusation about the wallet', async () => {
    statusThrows = true;
    const response = await confirm(confirmBody());
    assert.equal(response.body.outcome, 'verification_unavailable');
    assert.equal(response.body.refusal, null);
    assert.equal(response.body.retryable, true);
    // And no DB-only permission: the whole point of §10.
    await assertNothingStored();
  });

  test('no request shape lets a client name the spender, token or chain', async () => {
    // They are not fields of the request. `.strict()` refuses the attempt
    // rather than ignoring it, which is the difference between a boundary and
    // a habit.
    for (const extra of [{ spender: OTHER_WALLET }, { token: USDC }, { chainId: 1 }, { walletAddress: OTHER_WALLET }]) {
      const response = await confirm({ ...confirmBody(), ...extra });
      assert.equal(response.status, 400, `${JSON.stringify(extra)} was accepted`);
    }
    await assertNothingStored();
  });
});

describe('T71 — pause, resume and revoke', () => {
  const post = (path: string) =>
    request(routeApp()).post(`/api/route-intelligence/intelligence-budget/${path}`).send({});

  beforeEach(async () => {
    await confirm(confirmBody());
  });

  test('pausing keeps the budget visible and stops it being active', async () => {
    const paused = await post('pause');
    assert.equal(paused.status, 200);
    assert.equal(paused.body.budget.status, 'paused');

    // Visible in Settings — the reason `getLatestIntelligenceBudget` exists.
    const read = await request(routeApp()).get('/api/route-intelligence/intelligence-budget');
    assert.equal(read.body.budget.status, 'paused');

    // And invisible to anything that asks "may this wallet spend?".
    assert.equal(await repository.getActiveIntelligenceBudget(USER.id, WALLET, 8453), null);
  });

  test('resume needs no wallet action', async () => {
    await post('pause');
    let walletTouched = false;
    spendPermissionRouteRuntime.verifier = () => {
      walletTouched = true;
      return originalSpendRuntime.verifier();
    };
    const resumed = await post('resume');
    assert.equal(resumed.body.budget.status, 'active');
    assert.equal(walletTouched, false, 'resuming asked the wallet for something');
  });

  test('pausing twice is one pause', async () => {
    const first = await post('pause');
    const second = await post('pause');
    assert.equal(second.status, 200);
    assert.equal(second.body.budget.status, 'paused');
    assert.equal(second.body.budget.budgetId, first.body.budget.budgetId);
  });

  test('a paused budget can be revoked without resuming first', async () => {
    // Otherwise a user has to turn spending back on in order to turn it off.
    await post('pause');
    const revoked = await post('revoke');
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.budget.status, 'revoked');
  });

  test('revoking also stops Miorail drawing on the permission', async () => {
    await post('revoke');
    const stored = await permissions.getById(DERIVED_HASH.toLowerCase());
    assert.equal(stored?.isActive, false);
  });

  test('a revoked budget cannot be resumed', async () => {
    await post('revoke');
    const resumed = await post('resume');
    assert.equal(resumed.status, 409);
    assert.equal(resumed.body.code, 'intelligence_budget_not_resumable');
  });

  test('granting again after a revocation works', async () => {
    await post('revoke');
    // A genuinely new grant: different salt, so the chain derives a different
    // hash — and the claim must carry that hash, or it is refused for the same
    // reason a forged one would be.
    const newHash = `0x${'99'.repeat(32)}`;
    derivedHash = newHash;
    const again = await confirm(confirmBody({ salt: '777' }, { permissionHash: newHash }));
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.budget.status, 'active');
    assert.equal(again.body.budget.linkedSpendPermissionId, newHash);
  });
});

describe('T71 — what a paused or revoked budget blocks', () => {
  beforeEach(async () => {
    await confirm(confirmBody());
  });

  for (const action of ['pause', 'revoke'] as const) {
    test(`${action} leaves no active budget for a paid check to draw on`, async () => {
      await request(routeApp()).post(`/api/route-intelligence/intelligence-budget/${action}`).send({});
      // The coordinator resolves the ACTIVE budget by wallet. No active budget
      // is what stops a paid check; free route comparison never consults one.
      assert.equal(await repository.getActiveIntelligenceBudget(USER.id, WALLET, 8453), null);
      // And the record is still there, so the user is told which of the two
      // situations they are in.
      const latest = await repository.getLatestIntelligenceBudget(USER.id, WALLET, 8453);
      assert.equal(latest?.status, action === 'pause' ? 'paused' : 'revoked');
    });
  }

  test('the budget hash still verifies after a status change', async () => {
    // The hash fingerprints the budget's policy including its status, so a
    // status written without rehashing would fail closed on the next read.
    await request(routeApp()).post('/api/route-intelligence/intelligence-budget/pause').send({});
    const record = await repository.getLatestIntelligenceBudget(USER.id, WALLET, 8453);
    assert.ok(record);
    const recomputed = hashIntelligenceBudgetV1({
      schemaVersion: 'intelligence-budget/v1',
      id: record.id,
      tenantId: record.userId,
      walletAddress: record.walletAddress as `0x${string}`,
      chainId: 8453,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: record.status,
      spendPermissionId: record.spendPermissionId,
      periodType: 'monthly',
      asset: {
        assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        chainId: 8453,
        kind: 'erc20',
        address: USDC as `0x${string}`,
        symbol: 'USDC',
        decimals: 6,
      },
      periodLimitAtomic: record.periodLimitAtomic,
      periodSpentAtomic: record.periodSpentAtomic,
      reservedAtomic: record.reservedAtomic,
      maxPerCallAtomic: record.maxPerCallAtomic,
      allowedCategories: record.allowedCategories as never,
      periodStartedAt: record.periodStartedAt,
      periodEndsAt: record.periodEndsAt,
      revokedAt: record.revokedAt,
      budgetHash: ZERO_HASH_V1,
    });
    assert.equal(record.budgetHash, recomputed);
  });
});

// ---------------------------------------------------------------------------
// T71.1 — the shape a Base Account actually returns.
//
// Every fixture above was written by hand, and every one of them happened to
// use a decimal salt and a finite end. The wallet does neither. `@base-org/account`
// builds its message in `createSpendPermissionTypedData`:
//
//   salt: salt ?? getRandomHexString(32)   -> '0x' + 64 hex characters
//   end:  end  ?? ETERNITY_TIMESTAMP       -> 281474976710655 (uint48 max)
//
// So the wire schema and the SDK never met, and the first real grant died in
// `safeParse` in about a millisecond — before the chain was asked anything, and
// with a 400 the UI could only render as "still not configured".
//
// These tests are the meeting. They post what the wallet produces.
// ---------------------------------------------------------------------------

/** uint48 max — what `@base-org/account` writes when a grant has no end date. */
const ETERNITY_TIMESTAMP = 281_474_976_710_655;

/** 32 random bytes, hex — what `getRandomHexString(32)` returns. */
const WALLET_SALT = `0x${'7f'.repeat(32)}`;

describe('T71.1 — a permission as @base-org/account emits it', () => {
  test('a hex salt is accepted, because that is what the wallet signs', async () => {
    const response = await confirm(confirmBody({ salt: WALLET_SALT }));
    // 201: a confirmation that has nothing to reuse creates the budget.
    assert.equal(response.status, 201);
    assert.equal(response.body.outcome, 'activated');
  });

  test('a decimal salt is still accepted — wallets disagree about how to write a uint256', async () => {
    const response = await confirm(confirmBody({ salt: '12345' }));
    // 201: a confirmation that has nothing to reuse creates the budget.
    assert.equal(response.status, 201);
    assert.equal(response.body.outcome, 'activated');
  });

  test('the salt reaches the verifier byte for byte, because it is hash preimage', async () => {
    let seen: string | undefined;
    const inner = spendPermissionRouteRuntime.verifier();
    spendPermissionRouteRuntime.verifier = () => ({
      ...inner,
      async derivedHash(claim) {
        seen = claim.permission.salt;
        return derivedHash;
      },
    });
    await confirm(confirmBody({ salt: WALLET_SALT }));
    // Not lowercased, not re-encoded, not widened to 32 bytes: the exact
    // characters. Anything else derives a different hash on chain.
    assert.equal(seen, WALLET_SALT);
  });

  test('a salt that is not a uint256 in either notation is still refused', async () => {
    for (const salt of ['0x', 'abc', '0xzz', '', `0x${'f'.repeat(65)}`, '-1', '1.5']) {
      const response = await confirm(confirmBody({ salt }));
      assert.equal(response.status, 400, salt);
    }
  });

  test('a permission with no end date is stored, not fatal', async () => {
    // uint48 max in milliseconds is 2.8e17 — past MAX_SAFE_INTEGER and past what
    // `new Date()` can hold. Before the clamp this passed every check and then
    // failed on the INSERT.
    const response = await confirm(confirmBody({ salt: WALLET_SALT, end: ETERNITY_TIMESTAMP }));
    // 201: a confirmation that has nothing to reuse creates the budget.
    assert.equal(response.status, 201);
    assert.equal(response.body.outcome, 'activated');

    const stored = (await permissions.getById(DERIVED_HASH))!;
    assert.ok(stored, 'the permission was recorded');
    assert.ok(Number.isSafeInteger(stored.expiresAt));
    assert.ok(!Number.isNaN(new Date(stored.expiresAt).getTime()), 'the expiry is a real Date');
    // Far enough away to mean "no end", near enough to be a timestamp.
    assert.ok(stored.expiresAt > NOW.getTime());
    assert.equal(new Date(stored.expiresAt).getUTCFullYear(), 9999);
  });

  test('an ordinary end date is stored exactly, not clamped', async () => {
    const end = Math.floor(NOW.getTime() / 1000) + 60 * 60 * 24 * 60;
    await confirm(confirmBody({ salt: WALLET_SALT, end }));
    const stored = (await permissions.getById(DERIVED_HASH))!;
    assert.equal(stored.expiresAt, end * 1000);
  });

  test('the whole wallet-shaped claim activates a budget end to end', async () => {
    const response = await confirm(
      confirmBody({
        // Checksummed, exactly as `getAddress` returns them from the SDK.
        account: '0x1111111111111111111111111111111111111111',
        spender: '0x9999999999999999999999999999999999999999',
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        allowance: '3000000',
        period: 2_592_000,
        salt: WALLET_SALT,
        end: ETERNITY_TIMESTAMP,
        extraData: '0x',
      }),
    );
    // 201: a confirmation that has nothing to reuse creates the budget.
    assert.equal(response.status, 201);
    assert.equal(response.body.outcome, 'activated');
    assert.equal(response.body.budget.status, 'active');
    assert.equal(response.body.budget.linkedSpendPermissionId, DERIVED_HASH);
  });
});
