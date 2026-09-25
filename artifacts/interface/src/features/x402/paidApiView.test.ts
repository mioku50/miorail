import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  PAID_API_EXAMPLE_TOKEN_V1,
  PAID_RESOURCES_V1,
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
  test('offers the five resources the catalog sells, at the paths the server mounts', () => {
    assert.deepEqual(
      PAID_RESOURCES_V1.map((entry) => [entry.id, entry.path]),
      [
        ['address_identity_check', '/address/identity'],
        ['stock_representation_choice', '/stocks/representations'],
        ['b20_exit_analysis', '/b20/exit-analysis'],
        ['b20_liquidity_evidence', '/b20/liquidity-evidence'],
        ['enhanced_route_proof', '/route-proofs/enhanced'],
      ],
    );
  });

  test('the prefilled examples are requests the server answers with its price, not a refusal', () => {
    // Measured 2026-09-25 without paying: each of these reached the 402.
    assert.deepEqual(paidRequestUrlV1(resource('address_identity_check'), examplesOfV1(resource('address_identity_check'))), {
      ok: true,
      url: `/api/x402/intelligence/v1/address/identity?tokenAddress=${PAID_API_EXAMPLE_TOKEN_V1}`,
    });
    assert.deepEqual(paidRequestUrlV1(resource('stock_representation_choice'), examplesOfV1(resource('stock_representation_choice'))), {
      ok: true,
      url: '/api/x402/intelligence/v1/stocks/representations?underlyingKey=security%3Aisin%3AUS67066G1040&direction=buy&sizeUsdc=100',
    });
    // An empty optional field is left out, so the server applies its default.
    assert.deepEqual(paidRequestUrlV1(resource('b20_exit_analysis'), examplesOfV1(resource('b20_exit_analysis'))), {
      ok: true,
      url: `/api/x402/intelligence/v1/b20/exit-analysis?tokenAddress=${PAID_API_EXAMPLE_TOKEN_V1}`,
    });
  });

  test('a malformed ask is stopped before the wallet, in the server’s own rules', () => {
    const refusals = [
      paidRequestUrlV1(resource('address_identity_check'), { tokenAddress: 'NVDA' }),
      paidRequestUrlV1(resource('stock_representation_choice'), { underlyingKey: 'NVDA' }),
      paidRequestUrlV1(resource('stock_representation_choice'), { underlyingKey: 'security:isin:US67066G1040', sizeUsdc: '250' }),
      paidRequestUrlV1(resource('stock_representation_choice'), { underlyingKey: 'security:isin:US67066G1040', direction: 'short' }),
      paidRequestUrlV1(resource('b20_exit_analysis'), { tokenAddress: PAID_API_EXAMPLE_TOKEN_V1, positionUsdc: '0' }),
      paidRequestUrlV1(resource('enhanced_route_proof'), { publicId: '' }),
      paidRequestUrlV1(resource('enhanced_route_proof'), { publicId: 'abc' }),
    ];
    for (const refusal of refusals) assert.equal(refusal.ok, false, JSON.stringify(refusal));
    // A proof id pasted in capitals is the same id.
    const upper = 'AB'.repeat(24);
    assert.deepEqual(paidRequestUrlV1(resource('enhanced_route_proof'), { publicId: upper }), {
      ok: true,
      url: `/api/x402/intelligence/v1/route-proofs/enhanced?publicId=${upper.toLowerCase()}`,
    });
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
