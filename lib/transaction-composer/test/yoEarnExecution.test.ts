import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, erc20Abi } from 'viem';
import { resolveEarnIntentV1 } from '@mioagent/intent-engine';
import {
  PINNED_BASE_USDC_V1,
  createYoEarnDataSourceV1,
  compareEarnRoutesV1,
  pinnedEarnVenueV1,
  type EarnChainReaderV1,
} from '@mioagent/earn-engine';
import {
  YO_GATEWAY_DEPOSIT_ABI,
  buildEarnDepositBlueprintV1,
  buildEarnDepositCallsV1,
} from '../src/earnComposition.js';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-08-13T10:00:00.000Z');

const reader: EarnChainReaderV1 = {
  async readMoonwellMarketSnapshot() {
    throw new Error('not used');
  },
  async readYoVaultSnapshot({ amountAtomic }) {
    assert.equal(amountAtomic, '100000000');
    return {
      blockNumber: '49911135',
      underlyingAsset: PINNED_BASE_USDC_V1,
      totalAssetsAtomic: '9699164861726',
      totalSupplyAtomic: '9154793382805',
      expectedSharesAtomic: '94387400',
    };
  },
};

async function yoCandidate() {
  const resolution = resolveEarnIntentV1({
    message: 'Deposit 100 USDC into a YO vault on Base.',
    tenantId: TENANT,
    walletAddress: WALLET,
    now: NOW,
  });
  assert.equal(resolution.status, 'ready');
  if (resolution.status !== 'ready') throw new Error('intent not ready');
  const result = await compareEarnRoutesV1(
    { dataSource: createYoEarnDataSourceV1({ chainReader: reader }) },
    { intent: resolution.intent, now: NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('YO candidate unavailable');
  return { intent: resolution.intent, candidate: result.entries[0]!.candidate };
}

test('YO candidate is onchain-backed while APY and instant liquidity stay honestly unscored', async () => {
  const { candidate } = await yoCandidate();
  assert.equal(candidate.protocol, 'yo');
  assert.equal(candidate.netApyBps, null);
  assert.equal(candidate.availableLiquidityAtomic, null);
  assert.equal(candidate.totalAssetsAtomic, '9699164861726');
  assert.equal(candidate.expectedPositionAtomic, '94387400');
  assert.equal(candidate.withdrawalModel, 'async_redeem');
  assert.deepEqual(candidate.contracts, {
    asset: PINNED_BASE_USDC_V1,
    target: pinnedEarnVenueV1('yo').target,
    approvalSpender: pinnedEarnVenueV1('yo').approvalSpender,
  });
});

test('YO deposit uses exact Gateway approval and a bounded share minimum', async () => {
  const { intent, candidate } = await yoCandidate();
  const calls = buildEarnDepositCallsV1({ intent, candidate, walletAddress: WALLET });
  assert.equal(calls.length, 2);
  const approval = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data });
  assert.equal(approval.functionName, 'approve');
  assert.equal(approval.args[0].toLowerCase(), candidate.contracts.approvalSpender);
  assert.equal(approval.args[1], 100000000n);
  const deposit = decodeFunctionData({ abi: YO_GATEWAY_DEPOSIT_ABI, data: calls[1]!.data });
  assert.equal(calls[1]!.to, candidate.contracts.approvalSpender);
  assert.equal(deposit.args[0].toLowerCase(), candidate.contracts.target);
  assert.deepEqual(deposit.args.slice(1), [100000000n, 93915463n, WALLET, 0]);
  const built = buildEarnDepositBlueprintV1({
    tenantId: TENANT,
    walletAddress: WALLET,
    intent,
    candidate,
    evidenceSetHash: `0x${'9'.repeat(64)}`,
    requestId: 'yo-build',
    now: NOW,
  });
  assert.equal(built.outcome, 'prepared');
  if (built.outcome === 'prepared') assert.equal(built.safety.verdict, 'allowed');
});
