import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeWalletAppPendingV1, trackWalletAppRequestsV1, walletAppPendingV1 } from './walletAppRequests';

// A paired wallet app's requests, counted while the person has to approve them.
function provider() {
  const answers = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  let next = 0;
  const sent: string[] = [];
  const p = {
    request: (args: { method: string }) => {
      sent.push(args.method);
      if (args.method === 'eth_chainId') return Promise.resolve('0x2105');
      const id = next++;
      return new Promise((resolve, reject) => { answers.set(id, { resolve, reject }); });
    },
  };
  return { p, sent, answer: (id: number, value: unknown) => answers.get(id)!.resolve(value), refuse: (id: number) => answers.get(id)!.reject(Object.assign(new Error('declined'), { code: 4001 })) };
}

test('counts only what the person approves, while it waits, and brings the app forward as each is sent', async () => {
  const wallet = provider(), opened: string[] = [];
  let seen = 0;
  const stop = subscribeWalletAppPendingV1(() => { seen++; });
  trackWalletAppRequestsV1(wallet.p, (method) => { opened.push(method); });
  assert.equal(await wallet.p.request({ method: 'eth_chainId' }), '0x2105');
  assert.equal(walletAppPendingV1(), 0);
  const signing = wallet.p.request({ method: 'personal_sign' });
  const sending = wallet.p.request({ method: 'wallet_sendCalls' });
  assert.equal(walletAppPendingV1(), 2);
  assert.deepEqual(opened, ['personal_sign', 'wallet_sendCalls']);
  assert.deepEqual(wallet.sent, ['eth_chainId', 'personal_sign', 'wallet_sendCalls']);
  wallet.answer(0, '0xsigned');
  assert.equal(await signing, '0xsigned');
  assert.equal(walletAppPendingV1(), 1);
  // A refusal ends the wait too.
  wallet.refuse(1);
  await assert.rejects(sending, /declined/);
  assert.equal(walletAppPendingV1(), 0);
  assert.ok(seen >= 4);
  stop();
});

test('tracks a provider once, however often the page asks', async () => {
  const wallet = provider(), opened: string[] = [];
  trackWalletAppRequestsV1(wallet.p, (method) => { opened.push(method); });
  trackWalletAppRequestsV1(wallet.p, (method) => { opened.push(`again:${method}`); });
  const signing = wallet.p.request({ method: 'personal_sign' });
  assert.equal(walletAppPendingV1(), 1);
  assert.deepEqual(opened, ['personal_sign']);
  wallet.answer(0, '0x1');
  await signing;
  assert.equal(walletAppPendingV1(), 0);
});
