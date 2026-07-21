import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EarnCandidateV1Schema,
  EarnRouteIntentV1Schema,
  hashEarnCandidateV1,
  hashEarnRouteIntentV1,
  type EarnCandidateV1,
  type EarnRouteIntentV1,
} from '../src/earn-contracts.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WALLET = '0x1111111111111111111111111111111111111111';
const MOONWELL_MARKET = '0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22';
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const T0 = '2026-07-21T10:00:00.000Z';
const T1 = '2026-07-21T10:10:00.000Z';

const usdcAsset = {
  assetId: `eip155:8453/erc20:${USDC}`,
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: USDC,
  symbol: 'USDC',
  decimals: 6,
};
const amount = { asset: usdcAsset, amountAtomic: '500000000', amountDecimal: '500' };

function buildIntent(overrides: Partial<EarnRouteIntentV1> = {}): EarnRouteIntentV1 {
  const draft = {
    schemaVersion: 'earn-route-intent/v1',
    id: 'intent-1',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: T0,
    updatedAt: T0,
    status: 'ready',
    intentHash: ZERO_HASH,
    goal: 'earn',
    asset: usdcAsset,
    amount,
    optimizationMode: 'best_net_yield',
    verificationDepth: 'standard',
    protocolConstraint: { mode: 'any', protocols: [] },
    executionRequested: false,
    ...overrides,
  } as EarnRouteIntentV1;
  return { ...draft, intentHash: hashEarnRouteIntentV1(draft) };
}

function buildCandidate(overrides: Partial<EarnCandidateV1> = {}): EarnCandidateV1 {
  const draft = {
    schemaVersion: 'earn-candidate/v1',
    id: 'cand-moonwell',
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: T0,
    updatedAt: T0,
    status: 'quoted',
    intentHash: buildIntent().intentHash,
    candidateHash: ZERO_HASH,
    protocol: 'moonwell',
    venue: { kind: 'moonwell_market', protocol: 'moonwell', address: MOONWELL_MARKET, identifier: 'Moonwell USDC' },
    asset: usdcAsset,
    amount,
    baseApyBps: 500,
    rewardApyBps: 80,
    netApyBps: 560,
    availableLiquidityAtomic: '250000000000',
    withdrawalModel: 'direct',
    estimatedGas: { gasUnits: '210000', maxFeePerGasWei: null, estimatedCostNative: null, estimatedCostUsd: null },
    callCount: 2,
    approvalCount: 1,
    observedAt: T0,
    expiresAt: T1,
    contracts: { asset: USDC, target: MOONWELL_MARKET, approvalSpender: MOONWELL_MARKET },
    provider: { id: 'curated-earn-v1', displayName: 'Curated Earn', kind: 'internal', operator: 'miorail' },
    ...overrides,
  } as EarnCandidateV1;
  return { ...draft, candidateHash: hashEarnCandidateV1(draft) };
}

test('earn intent parses and rejects a tampered hash', () => {
  const intent = buildIntent();
  assert.equal(EarnRouteIntentV1Schema.safeParse(intent).success, true);
  assert.equal(EarnRouteIntentV1Schema.safeParse({ ...intent, optimizationMode: 'lowest_risk' }).success, false);
});

test('earn intent rejects amount asset that differs from the earn asset', () => {
  const bad = buildIntent();
  const weth = { ...usdcAsset, assetId: 'eip155:8453/erc20:0x4200000000000000000000000000000000000006', address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 };
  const tampered = { ...bad, amount: { ...amount, asset: weth } };
  assert.equal(EarnRouteIntentV1Schema.safeParse(tampered).success, false);
});

test('earn candidate parses with integer basis-point APY', () => {
  const candidate = buildCandidate();
  const parsed = EarnCandidateV1Schema.safeParse(candidate);
  assert.equal(parsed.success, true);
  assert.equal(Number.isInteger(candidate.netApyBps), true);
});

test('earn candidate rejects net APY above base plus reward', () => {
  const candidate = buildCandidate({ baseApyBps: 500, rewardApyBps: 80, netApyBps: 700 });
  assert.equal(EarnCandidateV1Schema.safeParse(candidate).success, false);
});

test('morpho candidate must use vault_redeem withdrawal', () => {
  const morphoVault = '0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca';
  const candidate = buildCandidate({
    protocol: 'morpho',
    venue: { kind: 'morpho_vault', protocol: 'morpho', address: morphoVault, identifier: 'Morpho Flagship USDC' },
    withdrawalModel: 'direct', // wrong for morpho -> must be vault_redeem
    contracts: { asset: USDC, target: morphoVault, approvalSpender: morphoVault },
  });
  assert.equal(EarnCandidateV1Schema.safeParse(candidate).success, false);
});

test('earn candidate requires at least one approval and a covering call count', () => {
  assert.equal(EarnCandidateV1Schema.safeParse(buildCandidate({ approvalCount: 0 })).success, false);
  assert.equal(EarnCandidateV1Schema.safeParse(buildCandidate({ callCount: 1, approvalCount: 1 })).success, false);
});

test('earn candidate allows null liquidity (missing data -> Not scored upstream)', () => {
  const candidate = buildCandidate({ availableLiquidityAtomic: null });
  assert.equal(EarnCandidateV1Schema.safeParse(candidate).success, true);
});
