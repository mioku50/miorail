import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERC721_TRANSFER_TOPIC_V1,
  buildNftOwnershipReadV1,
  buildNftPurchaseProofV1,
  buildNftReceiptLegV1,
  findNftTransferV1,
  reconcileNftProofV1,
  type NftChainReaderV1,
  type NftReceiptLogV1,
} from '../src/index.js';
import { blueprintFixtureV1 } from './blueprint-fixture.js';

// ---------------------------------------------------------------------------
// T65.1 §5/§7 — a successful receipt is not a purchase.
//
// The chain reader is injected, so nothing here opens a socket. What these
// tests hold in place is that the three legs stay INDEPENDENT: a receipt that
// succeeded, a Transfer that fired, and an `ownerOf` that answers are three
// separate facts, and `completed` needs all three.
// ---------------------------------------------------------------------------

const BUYER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x9999999999999999999999999999999999999999';
const TX = `0x${'f'.repeat(64)}`;
const NOW = new Date('2026-07-26T12:10:00.000Z');

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}
function uint(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function transferLog(to: string, contract: string, tokenId: string): NftReceiptLogV1 {
  return { address: contract, topics: [ERC721_TRANSFER_TOPIC_V1, topic(OTHER), topic(to), uint(BigInt(tokenId))], data: '0x' };
}

function reader(overrides: Partial<NftChainReaderV1> = {}): NftChainReaderV1 {
  return {
    async readTransaction() {
      return null;
    },
    async readOwnerOf() {
      return null;
    },
    ...overrides,
  };
}

/** The proof as it stands right after submission: a hash to watch, nothing
 * confirmed. */
function pendingProof(blueprint: ReturnType<typeof blueprintFixtureV1>['blueprint']) {
  return buildNftPurchaseProofV1({
    blueprint,
    asset: blueprint.asset,
    seller: OTHER,
    receipt: buildNftReceiptLegV1({ receipt: null, actualNativeValueWei: null, submittedTransactionHash: TX }),
    transfer: findNftTransferV1({ logs: [], contractAddress: blueprint.asset.contractAddress, tokenId: blueprint.asset.tokenId, buyer: BUYER }),
    ownership: buildNftOwnershipReadV1({ owner: null, buyer: BUYER, blockNumber: null, observedAt: null, unavailableReason: 'The transaction has not been confirmed yet.' }),
    now: new Date('2026-07-26T12:05:00.000Z'),
  });
}

function scenario(chainReader: NftChainReaderV1) {
  const { blueprint } = blueprintFixtureV1();
  const current = pendingProof(blueprint);
  return reconcileNftProofV1(
    { chainReader },
    { blueprint, current, seller: OTHER, transactionHash: TX, existingEventCount: 1, now: NOW },
  );
}

function successReceipt(logs: NftReceiptLogV1[]) {
  return {
    receipt: { status: 'success' as const, transactionHash: TX, blockNumber: 30_000_000n, gasUsed: 210_000n, logs },
    actualNativeValueWei: '3580000000000000',
  };
}

describe('completed needs all three legs', () => {
  test('receipt + Transfer + ownerOf agreeing is completed', async () => {
    const { blueprint } = blueprintFixtureV1();
    const result = await scenario(
      reader({
        async readTransaction() {
          return successReceipt([transferLog(BUYER, blueprint.asset.contractAddress, blueprint.asset.tokenId)]);
        },
        async readOwnerOf() {
          return { owner: BUYER, blockNumber: '30000001' };
        },
      }),
    );
    assert.equal(result.proof.finalStatus, 'completed');
    assert.equal(result.proof.status, 'finalized');
    assert.equal(result.stillOpen, false);
    // The spend is read from the transaction, not copied from the card.
    assert.equal(result.proof.receipt.actualNativeValueWei, '3580000000000000');
  });

  test('a succeeded receipt with NO Transfer is never completed', async () => {
    const result = await scenario(
      reader({
        async readTransaction() {
          return successReceipt([]);
        },
        async readOwnerOf() {
          return { owner: BUYER, blockNumber: '30000001' };
        },
      }),
    );
    // Even with ownerOf naming the buyer: without the Transfer this
    // transaction did not demonstrably deliver the token, and the proof stays
    // open rather than claiming a purchase.
    assert.equal(result.proof.finalStatus, 'reconciliation_required');
    assert.equal(result.stillOpen, true);
  });

  test('a Transfer to somebody else is failed, not merely unconfirmed', async () => {
    const { blueprint } = blueprintFixtureV1();
    const result = await scenario(
      reader({
        async readTransaction() {
          return successReceipt([transferLog(OTHER, blueprint.asset.contractAddress, blueprint.asset.tokenId)]);
        },
        async readOwnerOf() {
          return { owner: OTHER, blockNumber: '30000001' };
        },
      }),
    );
    assert.equal(result.proof.finalStatus, 'failed');
    assert.equal(result.proof.transfer.status, 'wrong_recipient');
  });

  test('ownerOf naming somebody else is a mismatch, not a gap', async () => {
    const { blueprint } = blueprintFixtureV1();
    const result = await scenario(
      reader({
        async readTransaction() {
          return successReceipt([transferLog(BUYER, blueprint.asset.contractAddress, blueprint.asset.tokenId)]);
        },
        async readOwnerOf() {
          return { owner: OTHER, blockNumber: '30000001' };
        },
      }),
    );
    assert.equal(result.proof.ownership.status, 'mismatch');
    assert.equal(result.proof.finalStatus, 'failed');
  });

  test('an unanswered ownerOf keeps the proof open, and says why', async () => {
    const { blueprint } = blueprintFixtureV1();
    const result = await scenario(
      reader({
        async readTransaction() {
          return successReceipt([transferLog(BUYER, blueprint.asset.contractAddress, blueprint.asset.tokenId)]);
        },
      }),
    );
    assert.equal(result.proof.ownership.status, 'unverified');
    assert.ok(result.proof.ownership.unavailableReason);
    assert.equal(result.proof.finalStatus, 'reconciliation_required');
    assert.equal(result.stillOpen, true);
  });
});

describe('the reads that answered nothing are recorded too', () => {
  test('an unmined transaction stays pending and changes nothing', async () => {
    const result = await scenario(reader());
    assert.equal(result.proof.finalStatus, 'pending');
    assert.equal(result.changed, false);
    // Nothing moved, so nothing is appended — a log that grows without adding
    // a fact is just noise in an audit.
    assert.equal(result.events.length, 0);
  });

  test('a revert is terminal and spends no listing price', async () => {
    const result = await scenario(
      reader({
        async readTransaction() {
          return {
            receipt: { status: 'reverted', transactionHash: TX, blockNumber: 30_000_000n, gasUsed: 90_000n, logs: [] },
            actualNativeValueWei: '3580000000000000',
          };
        },
      }),
    );
    assert.equal(result.proof.finalStatus, 'transaction_failed');
    assert.equal(result.stillOpen, false);
  });

  test('events describe THIS proof and continue the sequence', async () => {
    const { blueprint } = blueprintFixtureV1();
    const result = await scenario(
      reader({
        async readTransaction() {
          return successReceipt([transferLog(BUYER, blueprint.asset.contractAddress, blueprint.asset.tokenId)]);
        },
        async readOwnerOf() {
          return { owner: BUYER, blockNumber: '30000001' };
        },
      }),
    );
    assert.ok(result.events.length >= 4);
    // Sequence continues from what is already stored — it never restarts.
    assert.equal(result.events[0].sequence, 1);
    for (const event of result.events) {
      assert.equal(event.proofHash, result.proof.proofHash);
    }
    assert.deepEqual(
      result.events.map((event) => event.eventKind),
      ['receipt_observed', 'transfer_observed', 'ownership_read', 'reconciliation_attempted', 'finalized'],
    );
  });

  test('ownerOf is not asked before the transaction is mined', async () => {
    let asked = 0;
    await scenario(
      reader({
        async readOwnerOf() {
          asked += 1;
          return { owner: BUYER, blockNumber: '1' };
        },
      }),
    );
    assert.equal(asked, 0);
  });

  test('a finalized proof is read, not re-opened', async () => {
    const { blueprint } = blueprintFixtureV1();
    const completed = buildNftPurchaseProofV1({
      blueprint,
      asset: blueprint.asset,
      seller: OTHER,
      receipt: buildNftReceiptLegV1({
        receipt: { status: 'success', transactionHash: TX, blockNumber: 30_000_000n, gasUsed: 1n, logs: [] },
        actualNativeValueWei: '1',
      }),
      transfer: findNftTransferV1({
        logs: [transferLog(BUYER, blueprint.asset.contractAddress, blueprint.asset.tokenId)],
        contractAddress: blueprint.asset.contractAddress,
        tokenId: blueprint.asset.tokenId,
        buyer: BUYER,
      }),
      ownership: buildNftOwnershipReadV1({ owner: BUYER, buyer: BUYER, blockNumber: 30_000_001n, observedAt: NOW }),
      now: NOW,
    });
    let touched = 0;
    const result = await reconcileNftProofV1(
      { chainReader: reader({ async readTransaction() { touched += 1; return null; } }) },
      { blueprint, current: completed, seller: OTHER, transactionHash: TX, existingEventCount: 5, now: NOW },
    );
    assert.equal(result.proof.proofHash, completed.proofHash);
    assert.equal(result.changed, false);
    assert.equal(touched, 0);
  });
});
