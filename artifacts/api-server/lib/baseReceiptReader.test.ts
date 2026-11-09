import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findOwnTransactionsAfterV1, isDelegatedAccountCodeV1 } from './baseReceiptReader.js';

// 2026-11-09: MetaMask's batch handle is the wallet's own, so a loan it sent through its EIP-7702 delegate
// is found by the account's own transaction count: the first block past each count holds that transaction.
const WALLET = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const DELEGATED = `0xef0100${'63c0c19a282a1b52b07dd5a65b58948a07dae32b'}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
function client(patch: { code?: string; landed?: Array<[bigint, number]>; latest?: bigint } = {}) {
  const landed = patch.landed ?? [[520n, 16], [700n, 17]];
  const counts = { reads: 0, blocks: 0 };
  return { counts, client: {
    getCode: async () => patch.code ?? DELEGATED,
    getBlockNumber: async () => patch.latest ?? 1_000n,
    getTransactionCount: async ({ blockNumber }: { blockNumber: bigint }) => { counts.reads += 1; return 16 + landed.filter(([at]) => blockNumber >= at).length; },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => { counts.blocks += 1;
      const own = landed.find(([at]) => at === blockNumber);
      return { transactions: [{ hash: hash(1), from: OTHER, nonce: 3 }, ...(own ? [{ hash: hash(Number(blockNumber)), from: WALLET.toUpperCase().replace('0X', '0x'), nonce: own[1] }] : [])] }; },
  } };
}

describe('the wallet’s own transactions after a review, by its own count', () => {
  it('finds each in the first block past its count, oldest first, and searches no more while the count stands', async () => {
    const { client: c, counts } = client();
    assert.deepEqual(await findOwnTransactionsAfterV1(c, WALLET, 500n), [hash(520), hash(700)]);
    const blocks = counts.blocks;
    assert.deepEqual(await findOwnTransactionsAfterV1(c, WALLET, 500n), [hash(520), hash(700)]);
    assert.equal(counts.blocks, blocks, 'the same count, the same answer, from memory');
  });
  it('says none landed, rather than guessing, and only for an EIP-7702 account', async () => {
    assert.deepEqual(await findOwnTransactionsAfterV1(client({ landed: [] }).client, WALLET, 500n), []);
    assert.deepEqual(await findOwnTransactionsAfterV1(client().client, WALLET, 1_000n), []);
    // A smart contract wallet's operations are sent by bundlers; a plain account has no delegate.
    assert.equal(await findOwnTransactionsAfterV1(client({ code: '0x6080604052' }).client, OTHER, 500n), null);
    assert.equal(await findOwnTransactionsAfterV1(client({ code: '0x' }).client, OTHER, 500n), null);
    assert.equal(isDelegatedAccountCodeV1(DELEGATED), true);
    assert.equal(isDelegatedAccountCodeV1(`${DELEGATED}00`), false);
  });
  it('is null when a read fails, not an empty answer', async () => {
    const { client: c } = client({ landed: [[600n, 16]] });
    assert.equal(await findOwnTransactionsAfterV1({ ...c, getBlock: async () => { throw new Error('rpc down'); } }, OTHER, 501n), null);
  });
});
