import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  SPEND_PERMISSION_INITIAL_STATE_V1,
  SPEND_PERMISSION_VERIFY_ATTEMPTS_V1,
  SPEND_PERMISSION_VERIFY_INTERVAL_MS_V1,
  runSpendPermissionOnboardingV1,
  verifySpendPermissionGrantV1,
  type ConfirmResultV1,
  type SpendPermissionFlowStateV1,
  type WalletGrantedPermissionV1,
} from './useSpendPermissionOnboarding';

// ---------------------------------------------------------------------------
// T71.1 §6/§7 — the flow a real Base Account produced.
//
// prepare 200, wallet approved, confirm 200, budget null, screen
// "Not configured". Every one of those was individually correct. What was wrong
// was that a typed non-activated outcome ended the flow, discarded a permission
// that already existed on chain, and left the user the button that opens the
// wallet for a SECOND grant.
//
// So these tests count wallet prompts. That is the assertion that matters: a
// retry which reopens the wallet is not a retry, it is a new permission wearing
// the same label.
//
// The clock is injected, so ten seconds of retry take microseconds here.
// ---------------------------------------------------------------------------

const PERMISSION: WalletGrantedPermissionV1 = {
  signature: `0x${'cd'.repeat(65)}`,
  chainId: 8453,
  permissionHash: `0x${'ab'.repeat(32)}`,
  permission: {
    account: '0x1111111111111111111111111111111111111111',
    spender: '0x9999999999999999999999999999999999999999',
    token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    allowance: '3000000',
    period: 2_592_000,
    start: 1_800_000_000,
    // What the SDK writes when a grant has no end date.
    end: 281_474_976_710_655,
    // 32 random bytes in hex — `getRandomHexString(32)`, not a decimal.
    salt: `0x${'7f'.repeat(32)}`,
    extraData: '0x',
  },
};

const LIMITS = { periodLimitUsdc: '3.00', maxPerCallUsdc: '0.02' };

const NOT_APPROVED: ConfirmResultV1 = {
  outcome: 'refused',
  refusal: 'not_approved_onchain',
  detail: 'Base has not confirmed this permission yet. Nothing has been charged.',
  retryable: true,
};

const WRONG_TOKEN: ConfirmResultV1 = {
  outcome: 'refused',
  refusal: 'token_mismatch',
  detail: 'That permission is for a different token, so Miorail did not accept it.',
  retryable: false,
};

const ACTIVATED: ConfirmResultV1 = {
  outcome: 'activated',
  refusal: null,
  detail: 'Paid evidence is active.',
  retryable: false,
  budget: { budgetId: 'budget-1', status: 'active' },
};

/** Collects every state the flow publishes, and replays them onto one object so
 * a test can assert both the sequence and where it ended. */
function recorder() {
  const states: SpendPermissionFlowStateV1[] = [];
  let current: SpendPermissionFlowStateV1 = { ...SPEND_PERMISSION_INITIAL_STATE_V1 };
  return {
    states,
    get final() {
      return current;
    },
    emit(patch: Partial<SpendPermissionFlowStateV1>) {
      current = { ...current, ...patch };
      states.push(current);
    },
    statuses() {
      return states.map((state) => state.status);
    },
  };
}

function harness(confirmResults: ConfirmResultV1[]) {
  let walletPrompts = 0;
  let confirmCalls = 0;
  let prepareCalls = 0;
  const waits: number[] = [];
  const confirmedPermissions: WalletGrantedPermissionV1[] = [];
  return {
    get walletPrompts() {
      return walletPrompts;
    },
    get confirmCalls() {
      return confirmCalls;
    },
    get prepareCalls() {
      return prepareCalls;
    },
    waits,
    confirmedPermissions,
    deps: {
      prepare: async () => {
        prepareCalls += 1;
        return {
          account: PERMISSION.permission.account,
          spender: PERMISSION.permission.spender,
          token: PERMISSION.permission.token,
          chainId: 8453,
          allowanceAtomic: '3000000',
          periodInDays: 30,
          consent: ['Miorail may charge up to 3.00 USDC per month.'],
          recipientLabel: 'Miorail service wallet',
        };
      },
      requestPermission: async () => {
        walletPrompts += 1;
        return PERMISSION;
      },
      confirm: async (input: { permission: WalletGrantedPermissionV1 }) => {
        confirmedPermissions.push(input.permission);
        const result = confirmResults[Math.min(confirmCalls, confirmResults.length - 1)];
        confirmCalls += 1;
        return result;
      },
      wait: async (ms: number) => {
        waits.push(ms);
      },
      attempts: SPEND_PERMISSION_VERIFY_ATTEMPTS_V1,
      intervalMs: SPEND_PERMISSION_VERIFY_INTERVAL_MS_V1,
    },
  };
}

describe('T71.1 — a permission that is not confirmed yet', () => {
  test('a retryable outcome, then activated, on one wallet prompt', async () => {
    const h = harness([NOT_APPROVED, ACTIVATED]);
    const log = recorder();
    await runSpendPermissionOnboardingV1(h.deps, LIMITS, log.emit);

    assert.equal(h.walletPrompts, 1, 'the wallet opened exactly once');
    assert.equal(h.prepareCalls, 1, 'nothing was re-prepared');
    assert.equal(h.confirmCalls, 2, 'the same permission was confirmed twice');
    assert.deepEqual(h.confirmedPermissions[0], h.confirmedPermissions[1], 'byte for byte the same permission');
    assert.equal(log.final.status, 'active');
    assert.equal(log.final.outcome, 'activated');
    assert.deepEqual(log.final.budget, { budgetId: 'budget-1', status: 'active' });
    // Nothing left to retry once it worked.
    assert.equal(log.final.grant, null);
  });

  test('the automatic retry is bounded and waits between checks', async () => {
    const h = harness([NOT_APPROVED]);
    const log = recorder();
    await runSpendPermissionOnboardingV1(h.deps, LIMITS, log.emit);

    assert.equal(h.confirmCalls, SPEND_PERMISSION_VERIFY_ATTEMPTS_V1, 'three checks, not more');
    assert.equal(h.waits.length, SPEND_PERMISSION_VERIFY_ATTEMPTS_V1 - 1, 'a wait between each, none after the last');
    // ~10 seconds end to end.
    const total = h.waits.reduce((sum, ms) => sum + ms, 0);
    assert.ok(total >= 7_000 && total <= 12_000, `${total}ms of waiting`);
    assert.equal(h.walletPrompts, 1, 'no retry ever reopened the wallet');
  });

  test('a refusal the server did not mark retryable is never retried', async () => {
    const h = harness([WRONG_TOKEN, ACTIVATED]);
    const log = recorder();
    await runSpendPermissionOnboardingV1(h.deps, LIMITS, log.emit);

    assert.equal(h.confirmCalls, 1, 'the client does not decide what may be retried');
    assert.equal(h.waits.length, 0);
    assert.equal(log.final.status, 'verification_failed');
    assert.equal(log.final.refusal, 'token_mismatch');
    assert.equal(log.final.detail, WRONG_TOKEN.detail);
  });

  test('after the checks run out the grant is kept, so a retry needs no wallet', async () => {
    const h = harness([NOT_APPROVED]);
    const log = recorder();
    await runSpendPermissionOnboardingV1(h.deps, LIMITS, log.emit);

    assert.equal(log.final.status, 'verification_retryable');
    assert.equal(log.final.refusal, 'not_approved_onchain');
    assert.ok(log.final.grant, 'the signed permission is still held');
    assert.deepEqual(log.final.grant?.permission, PERMISSION);
    assert.deepEqual(log.final.grant?.limits, LIMITS);
  });

  test('a manual retry confirms the held permission and opens no wallet', async () => {
    const first = harness([NOT_APPROVED]);
    const log = recorder();
    await runSpendPermissionOnboardingV1(first.deps, LIMITS, log.emit);
    const grant = log.final.grant!;

    // A separate harness for the retry, whose `requestPermission` would count a
    // prompt if anything reached for it.
    const second = harness([ACTIVATED]);
    await verifySpendPermissionGrantV1(second.deps, grant, log.emit);

    assert.equal(second.walletPrompts, 0, 'retry never opens a wallet');
    assert.equal(second.prepareCalls, 0, 'retry never re-prepares');
    assert.equal(second.confirmCalls, 1);
    assert.deepEqual(second.confirmedPermissions[0], PERMISSION);
    assert.equal(log.final.status, 'active');
  });

  test('the limits the wallet signed for are the limits every retry sends', async () => {
    const h = harness([NOT_APPROVED]);
    const log = recorder();
    await runSpendPermissionOnboardingV1(h.deps, LIMITS, log.emit);
    // Re-quoting a different monthly limit on retry would ask the server to
    // verify the permission against a ceiling the wallet never saw.
    assert.deepEqual(log.final.grant?.limits, LIMITS);
  });

  test('a transport failure keeps the grant rather than claiming nothing happened', async () => {
    let calls = 0;
    const log = recorder();
    await verifySpendPermissionGrantV1(
      {
        confirm: async () => {
          calls += 1;
          throw new Error('network');
        },
        wait: async () => {},
        attempts: 3,
        intervalMs: 10,
      },
      { permission: PERMISSION, limits: LIMITS },
      log.emit,
    );
    assert.equal(calls, 3, 'a transport failure is retried like any retryable outcome');
    assert.equal(log.final.status, 'verification_retryable');
    // The wallet signed. "Nothing was created" would be a guess, and a wrong one.
    assert.match(log.final.detail ?? '', /signed/);
  });

  test('a declined prompt sends nothing to the server and keeps no grant', async () => {
    let confirmCalls = 0;
    const log = recorder();
    await runSpendPermissionOnboardingV1(
      {
        prepare: async () => ({
          account: PERMISSION.permission.account,
          spender: PERMISSION.permission.spender,
          token: PERMISSION.permission.token,
          chainId: 8453,
          allowanceAtomic: '3000000',
          periodInDays: 30,
          consent: [],
          recipientLabel: 'Miorail service wallet',
        }),
        requestPermission: async () => {
          throw Object.assign(new Error('User rejected the request'), { code: 4001 });
        },
        confirm: async () => {
          confirmCalls += 1;
          return ACTIVATED;
        },
        wait: async () => {},
        attempts: 3,
        intervalMs: 10,
      },
      LIMITS,
      log.emit,
    );
    assert.equal(log.final.status, 'wallet_rejected');
    assert.equal(confirmCalls, 0, 'a declined prompt produced no permission, so there was nothing to report');
    assert.equal(log.final.grant, null);
  });

  test('a prepare failure never opens the wallet', async () => {
    let walletPrompts = 0;
    const log = recorder();
    await runSpendPermissionOnboardingV1(
      {
        prepare: async () => {
          throw new Error('spend_permission_unavailable');
        },
        requestPermission: async () => {
          walletPrompts += 1;
          return PERMISSION;
        },
        confirm: async () => ACTIVATED,
        wait: async () => {},
        attempts: 3,
        intervalMs: 10,
      },
      LIMITS,
      log.emit,
    );
    assert.equal(walletPrompts, 0);
    assert.equal(log.final.status, 'failed');
  });

  test('the user sees which check is running, and that nothing was charged', async () => {
    const h = harness([NOT_APPROVED, NOT_APPROVED, ACTIVATED]);
    const log = recorder();
    await runSpendPermissionOnboardingV1(h.deps, LIMITS, log.emit);
    const verifying = log.states.filter((state) => state.status === 'verifying');
    assert.equal(verifying.length, 3);
    assert.match(verifying[1].detail ?? '', /checking again \(2 of 3\)/);
    assert.match(verifying[1].detail ?? '', /Nothing has been charged/);
    assert.deepEqual(
      verifying.map((state) => state.attempt),
      [1, 2, 3],
    );
  });

  test('an activated outcome is never reported as a refusal, and vice versa', async () => {
    for (const [result, expected] of [
      [ACTIVATED, 'active'],
      [WRONG_TOKEN, 'verification_failed'],
      [{ ...NOT_APPROVED, retryable: true }, 'verification_retryable'],
      [
        { outcome: 'verification_unavailable', refusal: null, detail: 'Base could not be reached.', retryable: true },
        'verification_retryable',
      ],
    ] as [ConfirmResultV1, string][]) {
      const log = recorder();
      await verifySpendPermissionGrantV1(
        { confirm: async () => result, wait: async () => {}, attempts: 2, intervalMs: 1 },
        { permission: PERMISSION, limits: LIMITS },
        log.emit,
      );
      assert.equal(log.final.status, expected, JSON.stringify(result.outcome));
      // §7 — a non-activated outcome may never reach `active`.
      if (result.outcome !== 'activated') assert.notEqual(log.final.status, 'active');
    }
  });

  test('a non-activated outcome always carries a sentence to show', async () => {
    for (const result of [WRONG_TOKEN, NOT_APPROVED]) {
      const log = recorder();
      await verifySpendPermissionGrantV1(
        { confirm: async () => result, wait: async () => {}, attempts: 1, intervalMs: 1 },
        { permission: PERMISSION, limits: LIMITS },
        log.emit,
      );
      // Never null, never empty: an outcome with nothing to say renders as
      // silence, and silence in this panel reads as "not configured".
      assert.ok((log.final.detail ?? '').length > 0);
      assert.equal(log.final.detail, result.detail);
    }
  });
});
