import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AssetRefV1 } from '@mioagent/route-domain';
import {
  CANONICAL_BASE_USDC,
  ERC20_TRANSFER_TOPIC0,
  earnPositionProofOutcomeV1,
  reconstructEarnPositionV1,
  type EarnPositionReconstructionV1,
  type VerifiedReceiptLogV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T61 §8 — earn deposit Route Proof reconstruction. Synthetic ERC-20 Transfer
// logs only; no live chain reads. Covers: real Moonwell/Morpho deposits, a
// SUCCESS receipt whose position cannot be observed (→ reconciliation_required),
// a missing USDC debit, unsupported assets, and net-of-refund accounting.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const MOONWELL_TARGET = '0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22';
const MORPHO_TARGET = '0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca';

const USDC_ASSET: AssetRefV1 = {
  assetId: `eip155:8453/erc20:${CANONICAL_BASE_USDC}`,
  chainId: 8453,
  kind: 'erc20',
  address: CANONICAL_BASE_USDC,
  symbol: 'USDC',
  decimals: 6,
};
const MOONWELL_POSITION: AssetRefV1 = {
  assetId: `eip155:8453/erc20:${MOONWELL_TARGET}`,
  chainId: 8453,
  kind: 'erc20',
  address: MOONWELL_TARGET,
  symbol: 'mwUSDC',
  decimals: 8,
};
const MORPHO_POSITION: AssetRefV1 = {
  assetId: `eip155:8453/erc20:${MORPHO_TARGET}`,
  chainId: 8453,
  kind: 'erc20',
  address: MORPHO_TARGET,
  symbol: 'mwUSDC-vault',
  decimals: 18,
};

function padAddr(addr: string): string {
  return `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}
function amountData(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}
function transferLog(token: string, from: string, to: string, value: bigint): VerifiedReceiptLogV1 {
  return { address: token, topics: [ERC20_TRANSFER_TOPIC0, padAddr(from), padAddr(to)], data: amountData(value) };
}

describe('T61 earn position reconstruction', () => {
  test('Moonwell: reconstructs USDC debit + mToken credit and completes/matches', () => {
    const logs = [
      transferLog(CANONICAL_BASE_USDC, WALLET, MOONWELL_TARGET, 500_000_000n),
      transferLog(MOONWELL_TARGET, MOONWELL_TARGET, WALLET, 2_400_000_000_000n), // mTokens minted to wallet
    ];
    const reconstruction = reconstructEarnPositionV1({
      walletAddress: WALLET,
      usdcAsset: USDC_ASSET,
      positionAsset: MOONWELL_POSITION,
      successReceiptLogs: logs,
    });
    assert.equal(reconstruction.kind, 'reconstructed');
    if (reconstruction.kind !== 'reconstructed') return;
    assert.equal(reconstruction.usdcDebitAtomic, '500000000');
    assert.equal(reconstruction.positionCreditAtomic, '2400000000000');
    assert.equal(reconstruction.actualResult.outputAmountAtomic, '2400000000000');
    assert.equal(reconstruction.actualResult.outputAsset?.address, MOONWELL_TARGET);

    const outcome = earnPositionProofOutcomeV1({ reconstruction, anyReceiptSuccess: true, allReceiptsSuccess: true });
    assert.deepEqual(outcome, { finalStatus: 'completed', reconciliationState: 'matched' });
  });

  test('Morpho: reconstructs USDC debit + vault-share credit', () => {
    const logs = [
      transferLog(CANONICAL_BASE_USDC, WALLET, MORPHO_TARGET, 500_000_000n),
      transferLog(MORPHO_TARGET, '0x0000000000000000000000000000000000000000', WALLET, 498_000_000_000_000_000_000n),
    ];
    const reconstruction = reconstructEarnPositionV1({
      walletAddress: WALLET,
      usdcAsset: USDC_ASSET,
      positionAsset: MORPHO_POSITION,
      successReceiptLogs: logs,
    });
    assert.equal(reconstruction.kind, 'reconstructed');
    if (reconstruction.kind !== 'reconstructed') return;
    assert.equal(reconstruction.positionCreditAtomic, '498000000000000000000');
  });

  test('SUCCESS receipt with NO position credit is unprovable → reconciliation_required (receipt success ≠ deposit proof)', () => {
    const logs = [transferLog(CANONICAL_BASE_USDC, WALLET, MOONWELL_TARGET, 500_000_000n)];
    const reconstruction = reconstructEarnPositionV1({
      walletAddress: WALLET,
      usdcAsset: USDC_ASSET,
      positionAsset: MOONWELL_POSITION,
      successReceiptLogs: logs,
    });
    assert.equal(reconstruction.kind, 'unprovable');
    if (reconstruction.kind !== 'unprovable') return;
    assert.equal(reconstruction.reason, 'position_credit_absent');

    const outcome = earnPositionProofOutcomeV1({ reconstruction, anyReceiptSuccess: true, allReceiptsSuccess: true });
    assert.deepEqual(outcome, { finalStatus: 'reconciliation_required', reconciliationState: 'manual_review' });
  });

  test('a position credit with no observable USDC debit is unprovable', () => {
    const logs = [transferLog(MOONWELL_TARGET, MOONWELL_TARGET, WALLET, 2_400_000_000_000n)];
    const reconstruction = reconstructEarnPositionV1({
      walletAddress: WALLET,
      usdcAsset: USDC_ASSET,
      positionAsset: MOONWELL_POSITION,
      successReceiptLogs: logs,
    });
    assert.equal(reconstruction.kind, 'unprovable');
    if (reconstruction.kind !== 'unprovable') return;
    assert.equal(reconstruction.reason, 'usdc_debit_absent');
  });

  test('a non-canonical / native debit asset is unsupported (never a fabricated 0 debit)', () => {
    const nativeAsset: AssetRefV1 = { assetId: 'eip155:8453/native', chainId: 8453, kind: 'native', address: null, symbol: 'ETH', decimals: 18 };
    const reconstruction = reconstructEarnPositionV1({
      walletAddress: WALLET,
      usdcAsset: nativeAsset,
      positionAsset: MOONWELL_POSITION,
      successReceiptLogs: [],
    });
    assert.equal(reconstruction.kind, 'unprovable');
    if (reconstruction.kind !== 'unprovable') return;
    assert.equal(reconstruction.reason, 'unsupported_asset');
  });

  test('nets a partial refund out of the USDC debit and the position credit', () => {
    const logs = [
      transferLog(CANONICAL_BASE_USDC, WALLET, MOONWELL_TARGET, 500_000_000n),
      transferLog(CANONICAL_BASE_USDC, MOONWELL_TARGET, WALLET, 10_000_000n), // 10 USDC returned
      transferLog(MOONWELL_TARGET, MOONWELL_TARGET, WALLET, 2_400_000_000_000n),
    ];
    const reconstruction = reconstructEarnPositionV1({
      walletAddress: WALLET,
      usdcAsset: USDC_ASSET,
      positionAsset: MOONWELL_POSITION,
      successReceiptLogs: logs,
    });
    assert.equal(reconstruction.kind, 'reconstructed');
    if (reconstruction.kind !== 'reconstructed') return;
    assert.equal(reconstruction.usdcDebitAtomic, '490000000');
  });

  test('outcome policy: no success receipt is failed; a reconstructed partial is partial_failure', () => {
    const reconstructed: EarnPositionReconstructionV1 = {
      kind: 'reconstructed',
      actualResult: { assetChanges: [], outputAmountAtomic: '1', outputAsset: MOONWELL_POSITION },
      usdcDebitAtomic: '500000000',
      positionCreditAtomic: '1',
    };
    assert.deepEqual(
      earnPositionProofOutcomeV1({ reconstruction: reconstructed, anyReceiptSuccess: false, allReceiptsSuccess: false }),
      { finalStatus: 'failed', reconciliationState: 'failed' },
    );
    assert.deepEqual(
      earnPositionProofOutcomeV1({ reconstruction: reconstructed, anyReceiptSuccess: true, allReceiptsSuccess: false }),
      { finalStatus: 'partial_failure', reconciliationState: 'partial' },
    );
  });
});
