import assert from 'node:assert/strict';
import test from 'node:test';
import { connectStillCardWalletV1, type StillCardProviderV1 } from './stillCardWallet';
import { stillCardProjectIdV1, stillCardRequestV1 } from './stillCardStore';

// The card's wallet and its way to Still, against scripted answers. Every
// address, hash and suffix here is synthetic.
const WALLET = `0x${'1'.repeat(40)}`;
const SUFFIX = '0xabcdef80218021802180218021';
const CALL = { to: `0x${'2'.repeat(40)}`, data: '0x12345678', value: '0' };

function provider(input: { methods?: string[]; atomic?: string | null; account?: string; answers?: Record<string, unknown> } = {}) {
  const asked: Array<{ method: string; params?: unknown[] }> = [];
  let disconnected = false;
  const fake: StillCardProviderV1 = {
    on: () => {},
    connect: async () => undefined,
    disconnect: async () => { disconnected = true; },
    session: { namespaces: { eip155: { accounts: [input.account ?? `eip155:8453:${WALLET.toUpperCase().replace('0X', '0x')}`],
      methods: input.methods ?? ['eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus', 'wallet_getCapabilities'] } } },
    request: async <T,>(args: { method: string; params?: unknown[] }) => {
      asked.push(args);
      if (args.method === 'wallet_getCapabilities') {
        if (input.atomic === null) throw Object.assign(new Error('Method not found'), { code: -32601 });
        return { '0x2105': { atomic: { status: input.atomic ?? 'supported' } } } as T;
      }
      return (input.answers?.[args.method] ?? null) as T;
    },
  };
  return { fake, asked, disconnected: () => disconnected };
}

test('a wallet that sends an atomic batch on Base gets the loan as one, with the builder code as a capability', async () => {
  const { fake, asked } = provider({ answers: { wallet_sendCalls: { id: 'batch-1' } } });
  const wallet = await connectStillCardWalletV1(fake, { builderSuffix: SUFFIX });
  assert.deepEqual([wallet.address, wallet.batches], [WALLET, true]);
  assert.equal(await wallet.sendCalls([CALL, { ...CALL, value: '1000' }]), 'batch-1');
  const sent = asked.find((row) => row.method === 'wallet_sendCalls')!.params![0] as Record<string, unknown>;
  assert.deepEqual(sent, { version: '2.0.0', chainId: '0x2105', from: WALLET, atomicRequired: true,
    calls: [{ to: CALL.to, data: CALL.data, value: '0x0' }, { to: CALL.to, data: CALL.data, value: '0x3e8' }],
    capabilities: { dataSuffix: { value: SUFFIX, optional: true } } });
});

test('a wallet without batches goes in steps, each carrying the builder code in its own calldata', async () => {
  for (const scripted of [{ atomic: 'unsupported' }, { atomic: null }, { methods: ['eth_sendTransaction'] }]) {
    const { fake, asked } = provider({ ...scripted, answers: { eth_sendTransaction: `0x${'a'.repeat(64)}` } });
    const wallet = await connectStillCardWalletV1(fake, { builderSuffix: SUFFIX });
    assert.equal(wallet.batches, false, JSON.stringify(scripted));
    assert.equal(await wallet.sendOne(CALL), `0x${'a'.repeat(64)}`);
    const sent = asked.find((row) => row.method === 'eth_sendTransaction')!.params![0] as { data: string; from: string };
    assert.deepEqual([sent.from, sent.data], [WALLET, `0x12345678${SUFFIX.slice(2)}`]);
  }
});

test('receipts and batch hashes are read as the chain and the wallet say, and a wallet off Base is let go', async () => {
  const mined = provider({ answers: { eth_getTransactionReceipt: { status: '0x1' },
    wallet_getCallsStatus: { status: 200, receipts: [{ transactionHash: `0x${'B'.repeat(64)}` }] } } });
  const wallet = await connectStillCardWalletV1(mined.fake, { builderSuffix: null, sleep: async () => {} });
  assert.equal(await wallet.receipt(`0x${'a'.repeat(64)}`), 'success');
  assert.deepEqual(await wallet.batchHashes('batch-1'), [`0x${'b'.repeat(64)}`]);
  const pending = provider({ answers: { wallet_getCallsStatus: { status: 100, receipts: [] } } });
  assert.equal(await (await connectStillCardWalletV1(pending.fake, { builderSuffix: null })).batchHashes('batch-1'), null);
  const elsewhere = provider({ account: `eip155:1:${WALLET}` });
  await assert.rejects(connectStillCardWalletV1(elsewhere.fake, { builderSuffix: null }), /wallet_not_on_base/);
  assert.equal(elsewhere.disconnected(), true);
});

test('the card asks Still as the grant’s wallet, and refuses an answer for any other wallet', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const host = (reply: Record<string, unknown>) => ({ callServerTool: async (params: { name: string; arguments: Record<string, unknown> }) => {
    calls.push(params.arguments);
    return { structuredContent: reply };
  } });
  const ok = stillCardRequestV1(host({ status: 200, body: { attemptId: 'a1' }, wallet: WALLET }), WALLET.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(await ok('/api/route-intelligence/rwa/lending/executions/x/arm', { method: 'POST', body: JSON.stringify({ callsHash: '0x1' }) }), { attemptId: 'a1' });
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/route-intelligence/rwa/lending/executions/x/arm', body: { callsHash: '0x1' } });
  const theirs = stillCardRequestV1(host({ status: 200, body: {}, wallet: `0x${'2'.repeat(40)}` }), WALLET);
  await assert.rejects(theirs('/api/route-intelligence/rwa/lending/review/d'), /lending_draft_wrong_wallet/);
  const refused = stillCardRequestV1(host({ status: 409, body: { error: 'lending_submission_pending', detail: 'Check its recorded result.' }, wallet: WALLET }), WALLET);
  await assert.rejects(refused('/api/route-intelligence/rwa/lending/review/d'), /^Error: lending_submission_pending: Check its recorded result\.$/);
});

test('the WalletConnect project id is the one the server wrote, or none', () => {
  const doc = (content: string | null) => ({ querySelector: () => (content === null ? null : { getAttribute: () => content }) }) as unknown as Document;
  assert.equal(stillCardProjectIdV1(doc('0123456789abcdef0123456789abcdef')), '0123456789abcdef0123456789abcdef');
  assert.equal(stillCardProjectIdV1(doc('__STILL_WALLETCONNECT_PROJECT_ID__')), null);
  assert.equal(stillCardProjectIdV1(doc('')), null);
  assert.equal(stillCardProjectIdV1(doc(null)), null);
});
