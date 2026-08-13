import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  ExecutionProofPanel,
  NATIVE_OUTPUT_MANUAL_RECONCILIATION_COPY,
  formatDeviationBps,
  type ExecutionProofView,
} from '../src/ExecutionProof';
import { RouteHistoryList, routeHistoryProofTone, type RouteHistoryItemView } from '../src/RouteHistoryList';
import { formatAtomicAmount, formatCompactAtomicAmount } from '../src/formatAtomicAmount';

const here = path.dirname(url.fileURLToPath(import.meta.url));

const TX_HASH = `0x${'ab'.repeat(32)}`;

const BASE_PROOF: ExecutionProofView = {
  proofId: 'route-proof:test',
  blueprintHash: `0x${'5'.repeat(64)}`,
  approvedCallsHash: `0x${'6'.repeat(64)}`,
  provider: 'uniswap',
  expectedOutput: {
    amountAtomic: '38000000000000000',
    asset: { symbol: 'WETH', decimals: 18, address: '0x4200000000000000000000000000000000000006', kind: 'erc20' },
  },
  minimumOutput: '37810000000000000',
  actualOutput: '38000000000000000',
  outputDeviationBps: 0,
  minimumSatisfied: true,
  estimatedGas: { gasUnits: '190000', maxFeePerGasWei: '1500000000', estimatedCostNative: '0.000285', estimatedCostUsd: '0.71' },
  actualGas: { gasUnits: '185000', maxFeePerGasWei: null, estimatedCostNative: '0.000222', estimatedCostUsd: null },
  transactionHashes: [TX_HASH],
  receipts: [{ transactionHash: TX_HASH, status: 'success', blockNumber: '33123499', gasUsed: '185000' }],
  finalStatus: 'completed',
  reconciliationState: 'matched',
};

test('formatAtomicAmount formats by decimals with exact BigInt math', () => {
  assert.equal(formatAtomicAmount('38000000000000000', 18), '0.038');
  assert.equal(formatAtomicAmount('100000000', 6), '100');
  assert.equal(formatAtomicAmount('100000001', 6), '100.000001');
  assert.equal(formatAtomicAmount('0', 18), '0');
  assert.equal(formatAtomicAmount('123', 0), '123');
  // Amounts far beyond Number.MAX_SAFE_INTEGER stay exact.
  assert.equal(formatAtomicAmount('123456789012345678901234567890', 18), '123456789012.34567890123456789');
  // Malformed input is returned untouched, never coerced through a float.
  assert.equal(formatAtomicAmount('not-a-number', 18), 'not-a-number');
});

test('formatCompactAtomicAmount keeps small values exact and truncates large bounds conservatively', () => {
  assert.equal(formatCompactAtomicAmount('4000000000000000000000', 18), '4000');
  assert.equal(formatCompactAtomicAmount('11952475734632944328073399', 18), '11.95M');
  assert.equal(formatCompactAtomicAmount('11033777595221022306799686', 18), '11.03M');
  assert.equal(formatCompactAtomicAmount('999999999999999999999999', 18), '999.9K');
});

test('formatDeviationBps renders sign and percent, null when unknown', () => {
  assert.equal(formatDeviationBps(null), null);
  assert.equal(formatDeviationBps(0), '0.00%');
  assert.equal(formatDeviationBps(123), '+1.23%');
  assert.equal(formatDeviationBps(-500), '-5.00%');
});

test('ExecutionProofPanel pending state says confirmation is pending and assumes nothing', () => {
  const rendered = JSON.stringify(
    ExecutionProofPanel({
      proof: {
        ...BASE_PROOF,
        actualOutput: null,
        actualGas: null,
        outputDeviationBps: null,
        minimumSatisfied: null,
        receipts: [{ transactionHash: TX_HASH, status: 'unknown', blockNumber: null, gasUsed: null }],
        finalStatus: 'pending',
        reconciliationState: 'pending',
      },
      lifecycle: 'confirmed',
    }),
  );
  assert.ok(rendered.includes('"data-proof-final-status":"pending"'));
  assert.ok(rendered.includes('Pending confirmation'));
  assert.ok(rendered.includes('not verified'));
});

test('ExecutionProofPanel completed state shows outputs, deviation, gas, and explorer-linked receipts', () => {
  const rendered = JSON.stringify(ExecutionProofPanel({ proof: BASE_PROOF, lifecycle: 'completed' }));
  assert.ok(rendered.includes('"data-proof-final-status":"completed"'));
  assert.ok(rendered.includes('0.038 WETH'));
  assert.ok(rendered.includes('0.03781 WETH'));
  assert.ok(rendered.includes('0.00%'));
  assert.ok(rendered.includes('185000 units'));
  assert.ok(rendered.includes(`https://basescan.org/tx/${TX_HASH}`));
  assert.ok(rendered.includes('uniswap'));
  assert.ok(rendered.includes('matched'));
});

test('ExecutionProofPanel reconciliation_required renders the exact honest native-ETH copy', () => {
  const rendered = JSON.stringify(
    ExecutionProofPanel({
      proof: {
        ...BASE_PROOF,
        actualOutput: null,
        outputDeviationBps: null,
        minimumSatisfied: null,
        finalStatus: 'reconciliation_required',
        reconciliationState: 'manual_review',
      },
      lifecycle: 'reconciliation_required',
    }),
  );
  assert.ok(rendered.includes(NATIVE_OUTPUT_MANUAL_RECONCILIATION_COPY));
  assert.equal(
    NATIVE_OUTPUT_MANUAL_RECONCILIATION_COPY,
    'Transaction succeeded, but exact native ETH output could not be independently reconstructed. Manual reconciliation required.',
  );
});

const HISTORY_ITEM: RouteHistoryItemView = {
  routeRunId: 'run-1',
  createdAt: '2026-07-18T12:00:00.000Z',
  runStatus: 'ready',
  intentHash: `0x${'7'.repeat(64)}`,
  intentSummary: 'swap 100 USDC -> WETH',
  blueprintId: 'blueprint-1',
  blueprintStatus: 'approved',
  proofId: 'route-proof:test',
  proofFinalStatus: 'completed',
  reconciliationState: 'matched',
  provider: 'uniswap',
};

test('RouteHistoryList renders items with status badges and an intent summary', () => {
  const rendered = JSON.stringify(RouteHistoryList({ items: [HISTORY_ITEM], nextCursor: null }));
  assert.ok(rendered.includes('swap 100 USDC -&gt; WETH') || rendered.includes('swap 100 USDC -> WETH'));
  assert.ok(rendered.includes('"data-route-run-id":"run-1"'));
  assert.ok(rendered.includes('ready'));
  assert.ok(rendered.includes('approved'));
  assert.ok(rendered.includes('completed'));
  // JSX children render as ["reconciliation ", state] in the serialized tree.
  assert.ok(rendered.includes('reconciliation ') && rendered.includes('"matched"'));
});

test('RouteHistoryList shows an empty state and a Load more button only with a cursor', () => {
  const empty = JSON.stringify(RouteHistoryList({ items: [], nextCursor: null }));
  assert.ok(empty.includes('No route runs yet.'));

  const withCursor = JSON.stringify(
    RouteHistoryList({ items: [HISTORY_ITEM], nextCursor: 'bmV4dA', onLoadMore: () => undefined }),
  );
  assert.ok(withCursor.includes('Load more'));
  const withoutCursor = JSON.stringify(
    RouteHistoryList({ items: [HISTORY_ITEM], nextCursor: null, onLoadMore: () => undefined }),
  );
  assert.ok(!withoutCursor.includes('Load more'));
});

test('routeHistoryProofTone maps final statuses to honest tones', () => {
  assert.equal(routeHistoryProofTone('completed'), 'ok');
  assert.equal(routeHistoryProofTone('failed'), 'risk');
  assert.equal(routeHistoryProofTone('reconciliation_required'), 'warn');
  assert.equal(routeHistoryProofTone(null), 'neutral');
  assert.equal(routeHistoryProofTone('something-else'), 'neutral');
});

test('T58 lib/ui sources stay wagmi-free and never reference forbidden surfaces or 0n literals', () => {
  for (const file of ['ExecutionProof.tsx', 'RouteHistoryList.tsx', 'formatAtomicAmount.ts']) {
    const source = readFileSync(path.join(here, '..', 'src', file), 'utf8');
    assert.equal(/from 'wagmi'|from "wagmi"/.test(source), false, `${file} must be wagmi-free`);
    assert.equal(/send_calls|x402|actioninbox|spendpermission/i.test(source), false, `${file} must avoid forbidden surfaces`);
    assert.equal(/\b\d+n\b/.test(source), false, `${file} must use BigInt(...) instead of bigint literals (ES2017)`);
  }
});
