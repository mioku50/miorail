import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import { PINNED_BASE_USDC_V1, PINNED_EARN_VENUES_V1 } from '@mioagent/earn-engine';
import {
  createViemEarnPinnedContractReader,
  resetEarnContractPreflightCacheV1,
  resolveEarnContractPreflightV1,
  runEarnContractPreflightV1,
  type EarnRpcClientV1,
} from './earnPreflight.js';

// ---------------------------------------------------------------------------
// T62.1 §1 — production earn contract preflight. Every read goes through a FAKE
// EarnRpcClientV1; there is NO live RPC call. Fail-closed is the contract: a
// wrong chain id, missing bytecode, a non-USDC underlying, or missing ERC-4626
// reads must all resolve to a verification whose `ok` is false.
// ---------------------------------------------------------------------------

const MOONWELL = PINNED_EARN_VENUES_V1.moonwell.target;
const MORPHO = PINNED_EARN_VENUES_V1.morpho.target;

interface FakeClientOverrides {
  chainId?: number;
  chainIdThrows?: boolean;
  code?: (address: string) => `0x${string}` | undefined;
  read?: (address: string, functionName: string) => unknown;
}

/** A fake Base RPC where, by default, every pinned address is a live contract,
 * each venue's underlying/asset is canonical USDC, and every ERC-4626 read
 * succeeds. Overrides target a single failure mode per test. */
function fakeClient(overrides: FakeClientOverrides = {}): EarnRpcClientV1 {
  return {
    async getChainId() {
      if (overrides.chainIdThrows) throw new Error('rpc down');
      return overrides.chainId ?? 8453;
    },
    async getBytecode({ address }) {
      if (overrides.code) return overrides.code(address.toLowerCase());
      return '0x60016000'; // non-empty deployed code
    },
    async readContract({ address, functionName }) {
      if (overrides.read) return overrides.read(address.toLowerCase(), functionName);
      // asset()/underlying() -> canonical USDC; the numeric 4626 reads -> 0n.
      if (functionName === 'asset' || functionName === 'underlying') return PINNED_BASE_USDC_V1;
      return BigInt(0);
    },
  };
}

afterEach(() => {
  resetEarnContractPreflightCacheV1();
});

describe('runEarnContractPreflightV1 (uncached)', () => {
  test('all pinned contracts present + canonical + chain 8453 -> ok', async () => {
    const verification = await runEarnContractPreflightV1(fakeClient());
    assert.equal(verification.ok, true);
    assert.equal(verification.failures.length, 0);
    assert.equal(verification.usdc.codePresent, true);
    assert.equal(verification.venues.length, 3);
  });

  test('wrong chain id fails closed without reading any contract', async () => {
    let reads = 0;
    const verification = await runEarnContractPreflightV1(
      fakeClient({ chainId: 1, read: () => { reads += 1; return PINNED_BASE_USDC_V1; } }),
    );
    assert.equal(verification.ok, false);
    assert.deepEqual(verification.failures, ['wrong_chain_id']);
    assert.equal(reads, 0);
  });

  test('an unreachable RPC (getChainId throws) fails closed', async () => {
    const verification = await runEarnContractPreflightV1(fakeClient({ chainIdThrows: true }));
    assert.equal(verification.ok, false);
    assert.deepEqual(verification.failures, ['rpc_unreachable']);
  });

  test('missing Moonwell bytecode fails closed', async () => {
    const verification = await runEarnContractPreflightV1(
      fakeClient({ code: (address) => (address === MOONWELL ? '0x' : '0x6001') }),
    );
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.includes('moonwell_target_not_a_contract'));
  });

  test('a wrong USDC underlying (Moonwell market) fails closed', async () => {
    const verification = await runEarnContractPreflightV1(
      fakeClient({
        read: (address, fn) => {
          if (fn === 'underlying' && address === MOONWELL) return '0x4200000000000000000000000000000000000006';
          if (fn === 'asset' || fn === 'underlying') return PINNED_BASE_USDC_V1;
          return BigInt(0);
        },
      }),
    );
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.includes('moonwell_underlying_not_canonical_usdc'));
  });

  test('unavailable ERC-4626 reads on the Morpho vault fail closed', async () => {
    const verification = await runEarnContractPreflightV1(
      fakeClient({
        read: (address, fn) => {
          // asset()/underlying() are fine, but the vault's previewDeposit reverts.
          if (fn === 'asset' || fn === 'underlying') return PINNED_BASE_USDC_V1;
          if (fn === 'previewDeposit' && address === MORPHO) throw new Error('not implemented');
          return BigInt(0);
        },
      }),
    );
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.includes('morpho_missing_erc4626_reads'));
  });
});

describe('createViemEarnPinnedContractReader', () => {
  test('getCodeSize returns byte length (0 for empty code)', async () => {
    const reader = createViemEarnPinnedContractReader(fakeClient({ code: () => '0x' }));
    assert.equal(await reader.getCodeSize(MOONWELL), 0);
    const reader2 = createViemEarnPinnedContractReader(fakeClient({ code: () => '0xdeadbeef' }));
    assert.equal(await reader2.getCodeSize(MOONWELL), 4);
  });

  test('getVenueUnderlyingAsset lowercases the result and returns null on revert', async () => {
    const reader = createViemEarnPinnedContractReader(
      fakeClient({ read: (_a, fn) => (fn === 'underlying' ? '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' : PINNED_BASE_USDC_V1) }),
    );
    assert.equal(await reader.getVenueUnderlyingAsset({ protocol: 'moonwell', target: MOONWELL }), PINNED_BASE_USDC_V1);
    const reverting = createViemEarnPinnedContractReader(fakeClient({ read: () => { throw new Error('revert'); } }));
    assert.equal(await reverting.getVenueUnderlyingAsset({ protocol: 'morpho', target: MORPHO }), null);
  });
});

describe('resolveEarnContractPreflightV1 (cached)', () => {
  test('caches within the TTL — the client is built once', async () => {
    let clientBuilds = 0;
    const deps = {
      createClient: () => {
        clientBuilds += 1;
        return fakeClient();
      },
      now: () => 1_000,
      ttlMs: 60_000,
    };
    const first = await resolveEarnContractPreflightV1(deps);
    const second = await resolveEarnContractPreflightV1(deps);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(clientBuilds, 1);
  });

  test('re-runs after the TTL expires', async () => {
    let clientBuilds = 0;
    let clock = 1_000;
    const deps = {
      createClient: () => {
        clientBuilds += 1;
        return fakeClient();
      },
      now: () => clock,
      ttlMs: 60_000,
    };
    await resolveEarnContractPreflightV1(deps);
    clock += 60_001;
    await resolveEarnContractPreflightV1(deps);
    assert.equal(clientBuilds, 2);
  });
});
