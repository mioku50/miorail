import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERC721_TRANSFER_TOPIC_V1,
  NFT_PROOF_COPY_V1,
  buildNftOwnershipReadV1,
  buildNftReceiptLegV1,
  findNftTransferV1,
  nftProofNeedsReconciliationV1,
  type NftReceiptLogV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65.1 §5 — a successful receipt is not a purchase.
// ---------------------------------------------------------------------------

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
const COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
const OTHER = '0x9999999999999999999999999999999999999999';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}
function uint(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function erc721Transfer(from: string, to: string, tokenId: bigint, address = COLLECTION): NftReceiptLogV1 {
  // Four topics: the tokenId is INDEXED in ERC-721.
  return { address, topics: [ERC721_TRANSFER_TOPIC_V1, topic(from), topic(to), uint(tokenId)], data: '0x' };
}

function erc20Transfer(from: string, to: string, amount: bigint, address = USDC): NftReceiptLogV1 {
  // Three topics: the amount lives in `data`, not in a topic.
  return { address, topics: [ERC721_TRANSFER_TOPIC_V1, topic(from), topic(to)], data: uint(amount) };
}

describe('an ERC-20 transfer is never read as an NFT transfer', () => {
  test('a same-signature ERC-20 log with a matching number is ignored', () => {
    // The trap: ERC-20 and ERC-721 share Transfer(address,address,uint256), so
    // they share topic[0]. Only the topic COUNT tells them apart. Without that
    // check, 16668 units of a token would read as token id 16668.
    const leg = findNftTransferV1({
      logs: [erc20Transfer(SELLER, BUYER, BigInt(16668), COLLECTION)],
      contractAddress: COLLECTION,
      tokenId: '16668',
      buyer: BUYER,
    });
    assert.equal(leg.status, 'absent');
  });

  test('the real ERC-721 log is found', () => {
    const leg = findNftTransferV1({
      logs: [erc20Transfer(SELLER, BUYER, BigInt(1)), erc721Transfer(SELLER, BUYER, BigInt(16668))],
      contractAddress: COLLECTION,
      tokenId: '16668',
      buyer: BUYER,
    });
    assert.equal(leg.status, 'observed');
    assert.equal(leg.toAddress, BUYER);
    assert.equal(leg.fromAddress, SELLER);
    assert.equal(leg.logIndex, 1);
  });

  test('a transfer of a DIFFERENT token id from the same contract is not ours', () => {
    const leg = findNftTransferV1({
      logs: [erc721Transfer(SELLER, BUYER, BigInt(99999))],
      contractAddress: COLLECTION,
      tokenId: '16668',
      buyer: BUYER,
    });
    assert.equal(leg.status, 'absent');
  });

  test('a transfer of our token id from a DIFFERENT contract is not ours', () => {
    const leg = findNftTransferV1({
      logs: [erc721Transfer(SELLER, BUYER, BigInt(16668), OTHER)],
      contractAddress: COLLECTION,
      tokenId: '16668',
      buyer: BUYER,
    });
    assert.equal(leg.status, 'absent');
  });

  test('the token going to someone else is recorded, not discarded', () => {
    // "Nothing happened" and "it went somewhere else" are different facts.
    const leg = findNftTransferV1({
      logs: [erc721Transfer(SELLER, OTHER, BigInt(16668))],
      contractAddress: COLLECTION,
      tokenId: '16668',
      buyer: BUYER,
    });
    assert.equal(leg.status, 'wrong_recipient');
    assert.equal(leg.toAddress, OTHER);
  });
});

describe('a gap and a finding are different things', () => {
  test('an unreadable owner is unverified, with a reason', () => {
    const read = buildNftOwnershipReadV1({ owner: null, buyer: BUYER, blockNumber: null, observedAt: null });
    assert.equal(read.status, 'unverified');
    assert.ok(read.unavailableReason);
  });

  test('someone else owning it is a mismatch, never merely unverified', () => {
    const read = buildNftOwnershipReadV1({
      owner: OTHER,
      buyer: BUYER,
      blockNumber: 30_000_001n,
      observedAt: new Date('2026-07-26T12:00:00.000Z'),
    });
    assert.equal(read.status, 'mismatch');
    assert.equal(read.owner, OTHER);
  });

  test('the buyer owning it is verified, with the block it was read at', () => {
    const read = buildNftOwnershipReadV1({
      owner: BUYER.toUpperCase().replace('0X', '0x'),
      buyer: BUYER,
      blockNumber: '30000001',
      observedAt: new Date('2026-07-26T12:00:00.000Z'),
    });
    assert.equal(read.status, 'verified');
    assert.equal(read.owner, BUYER);
    assert.equal(read.blockNumber, '30000001');
  });
});

describe('a missing receipt is not a failure', () => {
  test('no receipt yet is pending; an unreadable one is unknown', () => {
    assert.equal(buildNftReceiptLegV1({ receipt: null, actualNativeValueWei: null }).status, 'pending');
    assert.equal(
      buildNftReceiptLegV1({ receipt: null, actualNativeValueWei: null, unavailable: true }).status,
      'unknown',
    );
  });

  test('a real receipt carries what was actually spent, not what was quoted', () => {
    const leg = buildNftReceiptLegV1({
      receipt: {
        status: 'success',
        transactionHash: `0x${'a'.repeat(64)}`,
        blockNumber: 30_000_000n,
        gasUsed: 210_000n,
        logs: [],
      },
      actualNativeValueWei: '3580000000000000',
    });
    assert.equal(leg.status, 'success');
    assert.equal(leg.blockNumber, '30000000');
    assert.equal(leg.gasUsed, '210000');
    assert.equal(leg.actualNativeValueWei, '3580000000000000');
  });
});

describe('reconciliation keeps looking', () => {
  test('only the open states are retried', () => {
    assert.equal(nftProofNeedsReconciliationV1('pending'), true);
    assert.equal(nftProofNeedsReconciliationV1('reconciliation_required'), true);
    assert.equal(nftProofNeedsReconciliationV1('completed'), false);
    assert.equal(nftProofNeedsReconciliationV1('failed'), false);
    assert.equal(nftProofNeedsReconciliationV1('transaction_failed'), false);
  });

  test('the copy never calls an unconfirmed purchase completed', () => {
    assert.match(NFT_PROOF_COPY_V1.reconciliation_required, /not a completed purchase/);
    assert.equal(/you own it/.test(NFT_PROOF_COPY_V1.reconciliation_required), false);
    assert.match(NFT_PROOF_COPY_V1.completed, /you own it/);
    // A revert spends gas but not the listing price.
    assert.match(NFT_PROOF_COPY_V1.transaction_failed, /was not bought/);
  });
});
