import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  PINNED_BASE_USDC_V1,
  PINNED_EARN_VENUES_V1,
  resolveEarnRouteEnablementV1,
  verifyPinnedEarnContractsV1,
  type EarnPinnedContractReaderV1,
  type PinnedEarnVerificationV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T62 §6 — pinned-contract verification + the flag gate. Every read goes through
// a FAKE reader; there is no live RPC call. Fail-closed is the contract:
// missing bytecode, a non-USDC underlying, an unreadable call, or missing
// ERC-4626 reads must all block enablement.
// ---------------------------------------------------------------------------

const MOONWELL = PINNED_EARN_VENUES_V1.moonwell.target;

/** A reader where everything verifies correctly, with per-check overrides. */
function fakeReader(overrides: Partial<EarnPinnedContractReaderV1> = {}): EarnPinnedContractReaderV1 {
  return {
    async getCodeSize() {
      return 4096;
    },
    async getVenueUnderlyingAsset() {
      return PINNED_BASE_USDC_V1;
    },
    async supportsErc4626Reads() {
      return true;
    },
    ...overrides,
  };
}

describe('verifyPinnedEarnContractsV1', () => {
  test('all pinned contracts present and canonical -> ok, no failures', async () => {
    const verification = await verifyPinnedEarnContractsV1(fakeReader());
    assert.equal(verification.ok, true);
    assert.equal(verification.failures.length, 0);
    assert.equal(verification.usdc.codePresent, true);
    assert.equal(verification.venues.length, 3);
    // Morpho and YO are ERC-4626 vaults; Moonwell stays null.
    const morpho = verification.venues.find((v) => v.protocol === 'morpho')!;
    const moonwell = verification.venues.find((v) => v.protocol === 'moonwell')!;
    assert.equal(morpho.erc4626Ok, true);
    assert.equal(moonwell.erc4626Ok, null);
  });

  test('missing canonical USDC bytecode fails closed', async () => {
    const verification = await verifyPinnedEarnContractsV1(
      fakeReader({ getCodeSize: async (address) => (address === PINNED_BASE_USDC_V1 ? 0 : 4096) }),
    );
    assert.equal(verification.ok, false);
    assert.equal(verification.usdc.codePresent, false);
    assert.ok(verification.failures.includes('canonical_usdc_not_a_contract'));
  });

  test('a pinned venue that is not a contract fails closed (no underlying read attempted)', async () => {
    let underlyingReads = 0;
    const verification = await verifyPinnedEarnContractsV1(
      fakeReader({
        getCodeSize: async (address) => (address === MOONWELL ? 0 : 4096),
        getVenueUnderlyingAsset: async ({ target }) => {
          underlyingReads += 1;
          assert.notEqual(target, MOONWELL, 'must not probe the underlying of a non-contract');
          return PINNED_BASE_USDC_V1;
        },
      }),
    );
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.includes('moonwell_target_not_a_contract'));
    assert.equal(underlyingReads, 2); // Morpho and YO were probed
  });

  test('a venue whose underlying is NOT canonical USDC fails closed', async () => {
    const verification = await verifyPinnedEarnContractsV1(
      fakeReader({
        getVenueUnderlyingAsset: async ({ protocol }) =>
          protocol === 'morpho' ? ('0x4200000000000000000000000000000000000006' as const) : PINNED_BASE_USDC_V1,
      }),
    );
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.includes('morpho_underlying_not_canonical_usdc'));
    const morpho = verification.venues.find((v) => v.protocol === 'morpho')!;
    assert.equal(morpho.underlyingMatchesUsdc, false);
  });

  test('an unreadable underlying call is a failure, never a silent pass', async () => {
    const verification = await verifyPinnedEarnContractsV1(
      fakeReader({ getVenueUnderlyingAsset: async () => null }),
    );
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.some((f) => f.endsWith('_underlying_unreadable')));
  });

  test('the Morpho vault missing ERC-4626 reads fails closed', async () => {
    const verification = await verifyPinnedEarnContractsV1(fakeReader({ supportsErc4626Reads: async () => false }));
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.includes('morpho_missing_erc4626_reads'));
  });
});

describe('resolveEarnRouteEnablementV1 (the §6 flag gate)', () => {
  const okVerification: PinnedEarnVerificationV1 = {
    ok: true,
    usdc: { address: PINNED_BASE_USDC_V1, codePresent: true },
    venues: [],
    failures: [],
  };

  test('flag off -> disabled regardless of verification', async () => {
    assert.deepEqual(resolveEarnRouteEnablementV1({ flagEnabled: false, verification: okVerification }), {
      enabled: false,
      reason: 'flag_disabled',
    });
  });

  test('flag on but no verification run -> disabled (pinned contracts unverified)', () => {
    assert.deepEqual(resolveEarnRouteEnablementV1({ flagEnabled: true, verification: null }), {
      enabled: false,
      reason: 'pinned_contracts_unverified',
    });
  });

  test('flag on but verification failed -> disabled, surfaces the first failure', () => {
    const failed: PinnedEarnVerificationV1 = { ...okVerification, ok: false, failures: ['morpho_underlying_not_canonical_usdc'] };
    assert.deepEqual(resolveEarnRouteEnablementV1({ flagEnabled: true, verification: failed }), {
      enabled: false,
      reason: 'morpho_underlying_not_canonical_usdc',
    });
  });

  test('flag on AND verification ok -> enabled', () => {
    assert.deepEqual(resolveEarnRouteEnablementV1({ flagEnabled: true, verification: okVerification }), {
      enabled: true,
      reason: null,
    });
  });
});
