import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  B20OpportunityClearanceV1Schema,
  B20_CLEARANCE_TTL_MS_V1,
  InMemoryB20ClearanceRepositoryV1,
  clearanceRefusalV1,
  type B20OpportunityClearanceV1,
} from '../src/index.js';
import { RouteStorageConflictError } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const TENANT = `eip155:8453:${WALLET}`;
const OTHER_TENANT = `eip155:8453:${OTHER_WALLET}`;
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NOW = new Date('2026-08-03T12:00:00.000Z');
const hash = (byte: string) => `0x${byte.repeat(64)}`;

function clearance(overrides: Partial<B20OpportunityClearanceV1> = {}): B20OpportunityClearanceV1 {
  return B20OpportunityClearanceV1Schema.parse({
    schemaVersion: 'b20-opportunity-clearance/v1',
    id: 'clearance-1',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    tokenAddress: TOKEN,
    quoteAsset: USDC,
    positionAtomic: '100000000',
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    profileIdentity: `${USDC}:100000000:300:300`,
    controlSnapshotHash: hash('a'),
    controlBlockNumber: '49450000',
    entryRouteHash: hash('b'),
    exitRouteHash: hash('c'),
    entrySourceKey: 'aerodrome:0xfac:0xusdc:0xtok:volatile',
    exitSourceKey: 'aerodrome:0xfac:0xtok:0xusdc:volatile',
    simulationRequestHash: hash('d'),
    simulationEvidenceHash: hash('e'),
    simulationBlockNumber: '49450001',
    entryProvider: 'aerodrome',
    viability: 'qualified',
    coverage: 'partial',
    viableRouteConfirmed: true,
    bestRouteConfirmed: false,
    simulatedReturnedAtomic: '99000000',
    simulatedAcquiredAtomic: '4200000000000000000000',
    simulatedRoundTripBps: 100,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1).toISOString(),
    ...overrides,
  });
}

const use = (overrides: Partial<Parameters<typeof clearanceRefusalV1>[0]> = {}) =>
  clearanceRefusalV1({
    clearance: clearance(),
    now: NOW,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    tokenAddress: TOKEN,
    profileIdentity: `${USDC}:100000000:300:300`,
    entryRouteHash: hash('b'),
    controlSnapshotHash: hash('a'),
    provider: 'aerodrome',
    ...overrides,
  });

describe('a clearance is not an allowlist entry', () => {
  test('the schema refuses one that never expires', () => {
    assert.throws(() =>
      B20OpportunityClearanceV1Schema.parse({
        ...clearance(),
        expiresAt: NOW.toISOString(),
      }),
    );
  });

  test('the schema refuses a round trip above the profile it names', () => {
    // A clearance recording a cost the user did not accept is not a clearance.
    assert.throws(() =>
      B20OpportunityClearanceV1Schema.parse({ ...clearance(), simulatedRoundTripBps: 301 }),
    );
  });

  test('only a qualified outcome can be stored at all', () => {
    assert.throws(() =>
      B20OpportunityClearanceV1Schema.parse({ ...clearance(), viability: 'provisional' }),
    );
  });

  test('nothing credential-shaped fits in the record', () => {
    const serialised = JSON.stringify(clearance());
    assert.equal(/https?:\/\//.test(serialised), false);
    assert.equal(/apikey|api_key|secret|bearer/i.test(serialised), false);
  });
});

describe('the gate refuses everything it was not issued for', () => {
  test('a matching request is allowed', () => {
    assert.equal(use(), null);
  });

  test('no clearance is a refusal, not a default allow', () => {
    assert.equal(use({ clearance: null }), 'clearance_missing');
  });

  test('another wallet is refused', () => {
    assert.equal(use({ walletAddress: OTHER_WALLET }), 'clearance_wallet_mismatch');
    assert.equal(use({ tenantId: OTHER_TENANT }), 'clearance_wallet_mismatch');
  });

  test('another token is refused', () => {
    assert.equal(use({ tokenAddress: USDC }), 'clearance_token_mismatch');
  });

  test('another profile is refused', () => {
    // Changing the position or either tolerance is a different question, and a
    // clearance for one must be unable to answer the other.
    assert.equal(use({ profileIdentity: `${USDC}:500000000:300:300` }), 'clearance_profile_mismatch');
    assert.equal(use({ profileIdentity: `${USDC}:100000000:900:300` }), 'clearance_profile_mismatch');
  });

  test('an expired clearance is refused', () => {
    assert.equal(
      use({ now: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1 + 1) }),
      'clearance_expired',
    );
  });

  test('a changed route is refused rather than silently re-routed', () => {
    assert.equal(use({ entryRouteHash: hash('f') }), 'clearance_route_mismatch');
  });

  test('changed controls invalidate the clearance', () => {
    // The controls are re-read at prepare time. A token that moved since it was
    // certified is a different token for this purpose.
    assert.equal(use({ controlSnapshotHash: hash('9') }), 'clearance_controls_changed');
  });

  test('another execution provider is refused', () => {
    assert.equal(use({ provider: 'uniswap' }), 'clearance_provider_mismatch');
  });

  test('a stale clearance for the wrong token names the token, not the expiry', () => {
    // The more useful sentence. A user who changed tokens should not be sent
    // looking for a timing problem.
    assert.equal(
      use({
        tokenAddress: USDC,
        now: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1 + 1),
      }),
      'clearance_token_mismatch',
    );
  });
});

describe('the in-memory store mirrors the database', () => {
  test('a clearance is immutable', async () => {
    const repository = new InMemoryB20ClearanceRepositoryV1();
    await repository.insertClearance(clearance());
    // Byte-identical is an ordinary retry.
    await repository.insertClearance(clearance());
    await assert.rejects(
      () => repository.insertClearance(clearance({ simulatedRoundTripBps: 120 })),
      RouteStorageConflictError,
    );
  });

  test('one tenant never reads another’s clearance', async () => {
    const repository = new InMemoryB20ClearanceRepositoryV1();
    await repository.insertClearance(clearance());
    assert.equal(await repository.getClearance('clearance-1', OTHER_TENANT), null);
    assert.ok(await repository.getClearance('clearance-1', TENANT));
  });

  test('an expired clearance is not the latest anything', async () => {
    const repository = new InMemoryB20ClearanceRepositoryV1();
    await repository.insertClearance(clearance());
    const found = await repository.latestClearance({
      tenantId: TENANT,
      walletAddress: WALLET,
      tokenAddress: TOKEN,
      profileIdentity: `${USDC}:100000000:300:300`,
      now: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1 + 1),
    });
    assert.equal(found, null);
  });

  test('a lookup is keyed by profile, so one size cannot answer another', async () => {
    const repository = new InMemoryB20ClearanceRepositoryV1();
    await repository.insertClearance(clearance());
    const found = await repository.latestClearance({
      tenantId: TENANT,
      walletAddress: WALLET,
      tokenAddress: TOKEN,
      profileIdentity: `${USDC}:500000000:300:300`,
      now: NOW,
    });
    assert.equal(found, null);
  });
});

describe('the schema and the migration agree', () => {
  const migration = readFileSync(
    path.join(here, '../../db/drizzle/0025_t68d_b20_opportunity_clearance.sql'),
    'utf8',
  );

  test('the database refuses a clearance that never expires', () => {
    assert.match(migration, /b20_clearance_ttl_check/);
    assert.match(migration, /"expires_at" > "created_at"/);
  });

  test('the lookup is indexed by profile, not only by token', () => {
    assert.match(migration, /"profile_identity"/);
  });

  test('there is nowhere to put a score', () => {
    assert.ok(!/score|rating|confidence/i.test(migration.replace(/^--.*$/gm, '')));
  });
});
