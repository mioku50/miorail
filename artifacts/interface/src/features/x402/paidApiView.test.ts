import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  PAID_RESOURCES_V1,
  payButtonV1,
  basescanTxUrlV1,
  examplesOfV1,
  paidRequestUrlV1,
  paidStateLineV1,
  payerRefusalV1,
  paymentTermsFromHeaderV1,
  renderedAnswerV1,
  usdcLabelV1,
} from './paidApiView';

const PAY_TO = '0x8e525BfCe1eF40Aa8075ef64E45421b5855C8909';

function resource(id: string) {
  const found = PAID_RESOURCES_V1.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found!;
}

function header(accepts: unknown[]): string {
  return btoa(JSON.stringify({ x402Version: 2, accepts }));
}

describe('the paid API page', () => {
  test('offers the one resource the catalog sells, at the path the server mounts', () => {
    assert.deepEqual(PAID_RESOURCES_V1.map((entry) => [entry.id, entry.path]), [['still_loan_quote', '/still/loan-quote']]);
  });

  test('the prefilled example is a request the server answers with its price, not a refusal', () => {
    // The Bazaar declares the same example, and the server's own test sends it through its preload.
    const quote = resource('still_loan_quote');
    assert.deepEqual(paidRequestUrlV1(quote, examplesOfV1(quote)), {
      ok: true,
      url: '/api/x402/intelligence/v1/still/loan-quote?asset=NVDAc&amount=10',
    });
    assert.deepEqual(paidRequestUrlV1(quote, { asset: 'cbBTC', amount: '0.01', borrowUsdc: '150' }), {
      ok: true,
      url: '/api/x402/intelligence/v1/still/loan-quote?asset=cbBTC&amount=0.01&borrowUsdc=150',
    });
  });

  test('a malformed ask is stopped before the wallet, in the server’s own rules', () => {
    const quote = resource('still_loan_quote');
    const asks: Record<string, string>[] = [
      { asset: 'NVDA', amount: '10' }, // a ticker names three issuers' contracts; Still lends against one
      { asset: '', amount: '10' },
      { asset: 'NVDAc', amount: '' },
      { asset: 'NVDAc', amount: '0' },
      { asset: 'NVDAc', amount: '-3' },
      { asset: 'NVDAc', amount: '10', borrowUsdc: '0' },
      { asset: 'NVDAc', amount: '10', borrowUsdc: '1.0000001' },
    ];
    for (const values of asks) {
      const refused = paidRequestUrlV1(quote, values);
      assert.equal(refused.ok, false, JSON.stringify(values));
    }
    // An exact token address and WETH are names the server takes.
    assert.equal(paidRequestUrlV1(quote, { asset: '0xb20000000000000000000078ee7ce2fe4908108c', amount: '1' }).ok, true);
    assert.equal(paidRequestUrlV1(quote, { asset: 'weth', amount: '0.5' }).ok, true);
  });

  test('the price and payTo are read from the server’s 402, never assumed', () => {
    const terms = paymentTermsFromHeaderV1(
      header([
        { scheme: 'exact', network: 'eip155:1', amount: '1', asset: PAY_TO, payTo: PAY_TO },
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '2000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: PAY_TO,
        },
      ]),
    );
    assert.deepEqual(terms, {
      payTo: PAY_TO,
      amountAtomic: '2000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      network: 'eip155:8453',
    });
    assert.equal(usdcLabelV1(terms!.amountAtomic), '0.002 USDC');
    assert.equal(usdcLabelV1('1500000'), '1.5 USDC');
    assert.equal(paymentTermsFromHeaderV1(null), null);
    assert.equal(paymentTermsFromHeaderV1('not base64 json'), null);
    assert.equal(paymentTermsFromHeaderV1(header([{ scheme: 'exact', network: 'eip155:1', amount: '1', asset: PAY_TO, payTo: PAY_TO }])), null);
  });

  test('the wallet payments go to is not asked to pay itself', () => {
    const terms = { payTo: PAY_TO, amountAtomic: '2000', asset: PAY_TO, network: 'eip155:8453' };
    assert.match(payerRefusalV1(PAY_TO.toLowerCase(), terms) ?? '', /paying itself/);
    assert.equal(payerRefusalV1('0x1111111111111111111111111111111111111111', terms), null);
    assert.equal(payerRefusalV1(PAY_TO, null), null);
  });

  test('a Pay button that cannot pay is disabled, with its reason beside it', () => {
    const ready = { busy: false, connected: true, payBlocked: null, walletReady: true };
    assert.deepEqual(payButtonV1(ready), { disabled: false, note: null });
    assert.deepEqual(payButtonV1({ ...ready, busy: true }), { disabled: true, note: null });
    assert.match(payButtonV1({ ...ready, connected: false }).note ?? '', /^Connect a wallet/);
    // The operator's case on 2026-11-16: the wallet payments go to, which would pay itself.
    const self = payButtonV1({ ...ready, payBlocked: 'paying itself' });
    assert.equal(self.disabled, true);
    assert.match(self.note ?? '', /Use another wallet/);
    assert.deepEqual(payButtonV1({ ...ready, walletReady: false }), { disabled: true, note: 'Waiting for the wallet to answer…' });
  });

  test('a settlement links to Base, and a long answer says it was cut', () => {
    assert.equal(basescanTxUrlV1(`0x${'a'.repeat(64)}`), `https://basescan.org/tx/0x${'a'.repeat(64)}`);
    assert.equal(basescanTxUrlV1('0x1234'), null);
    assert.equal(basescanTxUrlV1(null), null);
    const long = renderedAnswerV1({ text: 'x'.repeat(30_000) });
    assert.match(long, /more characters not shown$/);
    assert.equal(renderedAnswerV1({ ok: true }), '{\n  "ok": true\n}');
  });

  test('a cancelled signature says nothing was paid', () => {
    assert.equal(paidStateLineV1('cancelled', '0.002 USDC'), 'Cancelled in the wallet. Nothing was paid.');
    assert.equal(paidStateLineV1('awaiting_wallet_confirmation', '0.002 USDC'), 'Approve 0.002 USDC in your wallet.');
    assert.equal(paidStateLineV1('idle', '0.002 USDC'), null);
  });
});
