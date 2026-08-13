import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIntelligenceBudgetCharger } from './intelligenceBudgetCharger.js';
import { InMemorySpendPermissionChargeAttemptStoreV1 } from './spendPermissionChargeAttempts.js';

const PAYER = `0x${'11'.repeat(20)}` as const;
const OWNER = `0x${'22'.repeat(20)}` as const;
const PROOF = { txHash: `0x${'33'.repeat(32)}` };

function chargeInput(overrides: Record<string, unknown> = {}) {
  return {
    chargeId: 'intelligence-charge:test',
    tenantId: 'tenant-test',
    permissionId: 'permission-test',
    expectedPayer: PAYER,
    amountAtomic: '10000',
    idempotencyKey: 'idempotency-test',
    ...overrides,
  } as any;
}

describe('Intelligence Budget Spend Permission charger', () => {
  it('binds preflight to the authenticated payer', async () => {
    let reservedInput: any = null;
    let preflightInput: any = null;
    const fuel = {
      reserve(input: Record<string, unknown>) {
        reservedInput = input;
        return { success: true, reservation: { id: 'fuel-reservation' } };
      },
      release() {},
      async preflightReserved(input: Record<string, unknown>) {
        preflightInput = input;
        return { success: true };
      },
      async charge() {
        throw new Error('not used');
      },
    };
    const charger = createIntelligenceBudgetCharger({
      fuel: fuel as any,
      attemptStore: new InMemorySpendPermissionChargeAttemptStoreV1(),
      ownerAddressResolver: async () => OWNER,
    });

    const result = await charger.preflight({
      permissionId: 'permission-test',
      expectedPayer: PAYER,
      amountAtomic: '10000',
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(reservedInput?.expectedPayer, PAYER);
    assert.equal(preflightInput?.expectedPayer, PAYER);
    assert.equal(preflightInput?.expectedSubscriptionOwner, OWNER);
  });

  it('persists one proof and returns it without a second external charge', async () => {
    let chargeCalls = 0;
    const fuel = {
      reserve() { throw new Error('not used'); },
      release() {},
      async preflightReserved() { throw new Error('not used'); },
      async charge(input: Record<string, unknown>) {
        chargeCalls += 1;
        assert.equal(input.expectedPayer, PAYER);
        return { success: true, proof: PROOF };
      },
    };
    const charger = createIntelligenceBudgetCharger({
      fuel: fuel as any,
      attemptStore: new InMemorySpendPermissionChargeAttemptStoreV1(),
      ownerAddressResolver: async () => OWNER,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    const first = await charger.charge(chargeInput());
    const replay = await charger.charge(chargeInput());

    assert.deepEqual(first, { ok: true, proof: PROOF });
    assert.deepEqual(replay, first);
    assert.equal(chargeCalls, 1);
  });

  it('lets only the durable claim owner enter the external charge call', async () => {
    let chargeCalls = 0;
    let releaseCharge!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const hold = new Promise<void>((resolve) => { releaseCharge = resolve; });
    const fuel = {
      reserve() { throw new Error('not used'); },
      release() {},
      async preflightReserved() { throw new Error('not used'); },
      async charge() {
        chargeCalls += 1;
        signalStarted();
        await hold;
        return { success: true, proof: PROOF };
      },
    };
    const charger = createIntelligenceBudgetCharger({
      fuel: fuel as any,
      attemptStore: new InMemorySpendPermissionChargeAttemptStoreV1(),
      ownerAddressResolver: async () => OWNER,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    const firstPromise = charger.charge(chargeInput());
    await started;
    const concurrent = await charger.charge(chargeInput());
    assert.deepEqual(concurrent, {
      ok: false,
      reason: 'spend_permission_charge_in_progress',
      disposition: 'retry_later',
    });
    assert.equal(chargeCalls, 1);
    releaseCharge();
    assert.deepEqual(await firstPromise, { ok: true, proof: PROOF });
  });

  it('never repeats an external charge after its result became unknown', async () => {
    let chargeCalls = 0;
    const fuel = {
      reserve() { throw new Error('not used'); },
      release() {},
      async preflightReserved() { throw new Error('not used'); },
      async charge() {
        chargeCalls += 1;
        return { success: false, status: 'charge_failed' };
      },
    };
    const charger = createIntelligenceBudgetCharger({
      fuel: fuel as any,
      attemptStore: new InMemorySpendPermissionChargeAttemptStoreV1(),
      ownerAddressResolver: async () => OWNER,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    const first = await charger.charge(chargeInput());
    const replay = await charger.charge(chargeInput());

    assert.equal(first.ok, false);
    assert.equal(replay.ok, false);
    if (replay.ok) throw new Error('unreachable');
    assert.equal(replay.reason, 'spend_permission_charge_outcome_unknown');
    assert.equal(replay.disposition, 'reconciliation_required');
    assert.equal(chargeCalls, 1);
  });

  it('rejects reuse of an idempotency key with different financial facts', async () => {
    let chargeCalls = 0;
    const fuel = {
      reserve() { throw new Error('not used'); },
      release() {},
      async preflightReserved() { throw new Error('not used'); },
      async charge() {
        chargeCalls += 1;
        return { success: true, proof: PROOF };
      },
    };
    const charger = createIntelligenceBudgetCharger({
      fuel: fuel as any,
      attemptStore: new InMemorySpendPermissionChargeAttemptStoreV1(),
      ownerAddressResolver: async () => OWNER,
    });

    assert.equal((await charger.charge(chargeInput())).ok, true);
    const conflict = await charger.charge(chargeInput({ amountAtomic: '20000' }));
    assert.equal(conflict.ok, false);
    if (conflict.ok) throw new Error('unreachable');
    assert.equal(conflict.reason, 'spend_permission_charge_attempt_conflict');
    assert.equal(chargeCalls, 1);
  });
});
