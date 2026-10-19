import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteProofV1Schema, hashRouteProofV1 } from '@mioagent/route-domain';
import { USER_OPERATION_EVENT_TOPIC_V1, actualFeeV1 } from '../src/fee.js';
import type { VerifiedReceiptLogV1, VerifiedReceiptSourceV1 } from '../src/receipts.js';
import { createRouteProofReconciler } from '../src/reconciler.js';
import {
  NOW,
  TENANT,
  TX_HASH_1,
  WALLET,
  mockReceiptReader,
  seedRouteProofFixture,
  successSwapReceiptSource,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// The proof states the person's own fee, not the bundle's, and who paid it.
// The numbers are the operator's first trade of 2026-10-19: its operation used
// 477 132 gas in a bundle of 691 569, and cost 0.000003101358 ETH.
// ---------------------------------------------------------------------------

const ENTRY_POINT_V06 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const STRANGER = '0x2222222222222222222222222222222222222222';
const BUNDLER = '0x3333333333333333333333333333333333333333';
const PAYMASTER = '0x2faeb0760d4230ef2ac21496bb4f0b47d634fd4c';
const ZERO = '0x0000000000000000000000000000000000000000';

const word = (value: bigint) => value.toString(16).padStart(64, '0');
const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

function userOperationEvent(input: {
  sender: string;
  paymaster?: string;
  gasUsed: bigint;
  costWei: bigint;
  emitter?: string;
}): VerifiedReceiptLogV1 {
  return {
    address: input.emitter ?? ENTRY_POINT_V06,
    topics: [USER_OPERATION_EVENT_TOPIC_V1, `0x${'ab'.repeat(32)}`, topic(input.sender), topic(input.paymaster ?? ZERO)],
    data: `0x${word(BigInt(1))}${word(BigInt(1))}${word(input.costWei)}${word(input.gasUsed)}`,
  };
}

function bundle(logs: VerifiedReceiptLogV1[], over: Partial<VerifiedReceiptSourceV1> = {}): VerifiedReceiptSourceV1 {
  return {
    transactionHash: TX_HASH_1,
    status: 'success',
    blockNumber: BigInt(52800078),
    gasUsed: BigInt(691569),
    effectiveGasPriceWei: BigInt(6000000),
    logs,
    from: BUNDLER,
    ...over,
  };
}

test('a bundle carrying a stranger’s operation charges the person only for their own', () => {
  const fee = actualFeeV1(
    [
      bundle([
        userOperationEvent({ sender: STRANGER, paymaster: PAYMASTER, gasUsed: BigInt(214437), costWei: BigInt(1300000000000) }),
        userOperationEvent({ sender: WALLET, gasUsed: BigInt(477132), costWei: BigInt(3101358000000) }),
      ]),
    ],
    WALLET.toUpperCase().replace('0X', '0x'),
  );
  assert.deepEqual(fee, {
    actualGas: { gasUnits: '477132', maxFeePerGasWei: null, estimatedCostNative: '0.000003101358', estimatedCostUsd: null },
    feePaidBy: 'wallet',
  });
});

test('a paymaster on the person’s operation means the fee was sponsored', () => {
  const fee = actualFeeV1(
    [bundle([userOperationEvent({ sender: WALLET, paymaster: PAYMASTER, gasUsed: BigInt(264503), costWei: BigInt(1587018000000) })])],
    WALLET,
  );
  assert.equal(fee.feePaidBy, 'sponsor');
  assert.equal(fee.actualGas!.gasUnits, '264503');
});

test('only an EntryPoint’s word counts: a look-alike event elsewhere is ignored', () => {
  const fee = actualFeeV1(
    [
      bundle([
        userOperationEvent({
          sender: WALLET,
          paymaster: PAYMASTER,
          gasUsed: BigInt(1),
          costWei: BigInt(1),
          emitter: '0x4444444444444444444444444444444444444444',
        }),
      ]),
    ],
    WALLET,
  );
  // Nothing of the person's in the receipt, and a bundler sent it: the gas is
  // the transaction's, and who paid for the person is not established.
  assert.equal(fee.actualGas!.gasUnits, '691569');
  assert.equal(fee.feePaidBy, null);
});

test('a wallet that sent its own transaction paid its own gas', () => {
  const fee = actualFeeV1(
    [successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: '1', wethAmountAtomic: '1' })].map(
      (source) => ({ ...source, from: WALLET }),
    ),
    WALLET,
  );
  assert.deepEqual(fee, {
    actualGas: { gasUnits: '185000', maxFeePerGasWei: null, estimatedCostNative: '0.000222', estimatedCostUsd: null },
    feePaidBy: 'wallet',
  });
});

test('some sponsored, some not, reads as mixed; nothing verified reads as nothing', () => {
  const sponsored = bundle([userOperationEvent({ sender: WALLET, paymaster: PAYMASTER, gasUsed: BigInt(10), costWei: BigInt(10) })]);
  const paid = bundle(
    [userOperationEvent({ sender: WALLET, gasUsed: BigInt(20), costWei: BigInt(20) })],
    { transactionHash: `0x${'cd'.repeat(32)}` },
  );
  const fee = actualFeeV1([sponsored, paid], WALLET);
  assert.equal(fee.feePaidBy, 'mixed');
  assert.equal(fee.actualGas!.gasUnits, '30');
  assert.deepEqual(actualFeeV1([null], WALLET), { actualGas: null, feePaidBy: null });
});

test('the reconciled proof carries the person’s fee and who paid, and its hash covers both', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const swap = successSwapReceiptSource({
    transactionHash: TX_HASH_1,
    usdcAmountAtomic: seeded.intent.amount.amountAtomic,
    wethAmountAtomic: '38000000000000000',
  });
  const reader = mockReceiptReader({
    [TX_HASH_1]: bundle([
      ...swap.logs,
      userOperationEvent({ sender: STRANGER, gasUsed: BigInt(214437), costWei: BigInt(1300000000000) }),
      userOperationEvent({ sender: WALLET, gasUsed: BigInt(477132), costWei: BigInt(3101358000000) }),
    ]),
  });
  const reconciler = createRouteProofReconciler({ repository: seeded.repository, receiptReader: reader });
  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.proof.actualGas!.gasUnits, '477132');
  assert.equal(result.proof.feePaidBy, 'wallet');

  const stored = RouteProofV1Schema.parse(await seeded.repository.getProofProjection(seeded.proof.id, TENANT));
  assert.equal(stored.feePaidBy, 'wallet');
  assert.equal(hashRouteProofV1(stored), stored.proofHash);
  // The hash covers who paid…
  const { feePaidBy: _paidBy, ...legacy } = stored;
  assert.notEqual(hashRouteProofV1(legacy), stored.proofHash);
  // …and a proof written before the field existed hashes exactly as it did.
  assert.equal(hashRouteProofV1({ ...legacy, feePaidBy: undefined }), hashRouteProofV1(legacy));
});
