import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConsoleMiniShell } from '../src/console/ConsoleMini';
import {
  WalletBalancesCard,
  planWalletRowsV1,
  walletRegistryMarkViewV1,
  type WalletBalanceEntryV1,
} from '../src/console/WalletBalancesCard';

void React;

const OFFICIAL_AAPLC = '0xb2000000000000000000009ee8a7ce0fd7aad1fb';
const row = (over: Partial<WalletBalanceEntryV1> & Pick<WalletBalanceEntryV1, 'symbol' | 'address'>): WalletBalanceEntryV1 => ({
  balanceFormatted: '1.0000',
  ...over,
});

// Production, 2026-09-28: 15 "AAPLc" named "Apple Inc," at 0x2a97…8636 sat in
// both balance lists as one more holding. The official AAPLc is another
// contract. Routes AI's list also read a field the answer does not carry, so
// every dollar cell was a dash, USDC's included.
describe('what the wallet holds, against the official registry', () => {
  const rows: WalletBalanceEntryV1[] = [
    row({ symbol: 'ABTC', address: '0x16171b0000000000000000000000000000000019', balanceFormatted: '500.0000' }),
    row({
      symbol: 'AAPLc',
      address: '0x2a970e0000000000000000000000000000008636',
      balanceFormatted: '15.0000',
      registry: { standing: 'lookalike', ticker: 'AAPLc', officialAddress: OFFICIAL_AAPLC },
    }),
    row({ symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', balanceFormatted: '0.2813', usdValue: '0.28' }),
    row({ symbol: 'NVDA', address: '0xb20000000000000000000078ee7ce2fe4908108c', balanceFormatted: '0.0009', usdValue: '0.21', registry: { standing: 'official', ticker: 'NVDAc' } }),
    row({ symbol: 'ETH', address: 'native', balanceFormatted: '0.0003' }),
    row({ symbol: 'DUST', address: '0x4444444444444444444444444444444444444444', balanceFormatted: '0' }),
    row({ symbol: 'SPAM', address: '0x5555555555555555555555555555555555555555', possibleSpam: true }),
  ];

  test('Routes AI shows dollars, leads with what has a price, and drops zero and spam', () => {
    const plan = planWalletRowsV1(rows);
    // Priced first, by value; the rest alphabetically, as the balances card lists them.
    assert.deepEqual(plan.map((entry) => entry.asset), ['ETH', 'USDC', 'NVDA', 'AAPLc', 'ABTC']);
    assert.equal(plan.find((entry) => entry.asset === 'USDC')?.usd, '$0.28');
    assert.equal(plan.find((entry) => entry.asset === 'ABTC')?.usd, '—');
  });

  test('a lookalike says it is not the official one, and where the official one is', () => {
    const mark = walletRegistryMarkViewV1(rows[1]!.registry);
    assert.deepEqual([mark?.label, mark?.tone], ['not the official AAPLc', 'a']);
    assert.match(mark!.title, /0xb200…d1fb/);
    // Official is an identity, not a verdict: no quality colour.
    assert.deepEqual([walletRegistryMarkViewV1(rows[3]!.registry)?.label, walletRegistryMarkViewV1(rows[3]!.registry)?.tone], ['official NVDAc', 'n']);
    assert.equal(walletRegistryMarkViewV1(undefined), null);
  });

  test('the balances card carries both marks', () => {
    const html = renderToStaticMarkup(<WalletBalancesCard loading={false} unavailableReason={null} rows={rows} />);
    assert.match(html, /AAPLc<span class="tag a"[^>]*>not the official AAPLc<\/span>/);
    assert.match(html, /NVDA<span class="tag"[^>]*>official NVDAc<\/span>/);
  });
});

describe('the Base App header says where the reader is', () => {
  test('a section without a second line prints none', () => {
    const html = renderToStaticMarkup(
      <ConsoleMiniShell goalLine="Stocks" networkLabel="Base mainnet" connected blockNumber={null} theme="dark" onThemeChange={() => undefined} drawer={null} panels={null}>
        <div />
      </ConsoleMiniShell>,
    );
    assert.match(html, /<div class="goalline">Stocks<\/div>/);
    assert.doesNotMatch(html, /stepline|New goal|Not started/);
  });
});
