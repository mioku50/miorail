import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RepresentationUseAccessV1 } from '@mioagent/rwa-issuer/useAccess';

import { Chooser } from '../src/console/MarketRealityScreen';
import {
  stockChangeLabelV1,
  stockPriceLabelV1,
  stockPriceNoteV1,
  stockQuoteViewsByKeyV1,
} from '../src/console/stockQuotesView';
import { compactUsdV1, morphoMarketUrlV1, stockUsesViewV1 } from '../src/console/stockUsesView';
import type { UnderlyingChoiceViewV1 } from '../src/console/marketRealityView';

void React;

const NOW = new Date('2026-10-03T14:00:00Z');
const NVDA = 'security:isin:US67066G1040';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MARKET = '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13';

describe('the list reads like a list of stocks', () => {
  test('prices and changes are written the way money is', () => {
    assert.equal(stockPriceLabelV1(234.3149), '$234.31');
    assert.equal(stockPriceLabelV1(1722.7), '$1,722.70');
    // Below a dollar, cents would erase the move.
    assert.equal(stockPriceLabelV1(0.44213), '$0.4421');
    assert.equal(stockChangeLabelV1(0.0042), '+0.42%');
    assert.equal(stockChangeLabelV1(-0.004), '−0.40%');
    assert.equal(stockChangeLabelV1(0.00001), '0.00%');
    assert.equal(stockPriceNoteV1('2026-10-03T13:46:00Z', NOW), 'Price on Base · 14 min ago');
    assert.equal(stockPriceNoteV1(null, NOW), null);
  });

  test('a tile leads with the ticker, names the company, and shows a price only when there is one', () => {
    const choice = (key: string, ticker: string, company: string | null): UnderlyingChoiceViewV1 => ({
      underlyingKey: key,
      title: ticker,
      ticker,
      company,
      identifier: null,
      issuerLine: 'Coinbase',
      issuerIds: ['coinbase'],
      representationCount: 1,
      multiIssuer: false,
      emptyNote: null,
    });
    const quotes = stockQuoteViewsByKeyV1({
      schemaVersion: 'stock-quotes/v1',
      asOf: NOW.toISOString(),
      rows: [
        {
          underlyingKey: NVDA,
          tokenAddress: NVDAC,
          tokenSymbol: 'NVDAc',
          companyName: 'NVIDIA Corporation',
          iconPath: `/api/public/stocks/icons/${NVDAC}.png`,
          priceUsd: 234.31,
          priceAt: '2026-10-03T13:46:00Z',
          change24h: 0.0042,
          changeFromAt: '2026-10-02T14:05:00Z',
        },
      ],
    });
    const markup = renderToStaticMarkup(
      <Chooser
        choices={[choice(NVDA, 'NVDA', null), choice('security:isin:US0231351067', 'AMZN', 'Amazon.com Inc.')]}
        quotes={quotes}
        selectedKey={NVDA}
        loading={false}
        error={null}
        onUnderlying={() => undefined}
      />,
    );
    // Coinbase's icon, from our own origin, decorative beside the ticker.
    assert.match(markup, new RegExp(`<img class="mr-choice-icon" src="/api/public/stocks/icons/${NVDAC}.png" alt=""`));
    assert.match(markup, /<span class="mr-choice-name">NVDA<\/span><span class="mr-choice-px mono">\$234\.31<\/span>/);
    assert.match(markup, /<span class="mr-choice-company">NVIDIA Corporation<\/span>/);
    assert.match(markup, /<span class="mr-choice-chg mono">\+0\.42%<\/span>/);
    // No quote, no price, no $0 — a letter instead of an icon.
    assert.match(markup, /<span class="mr-choice-icon mr-choice-letter" aria-hidden="true">A<\/span><span class="mr-choice-name">AMZN<\/span><span class="mr-choice-px mono"><\/span>/);
    assert.doesNotMatch(markup, /\$0\.00|\$0</);
    // The change carries no colour: no tone, no green, no red.
    assert.doesNotMatch(markup, /mr-choice-chg[^"]*(good|bad|up|down)/);
  });
});

describe('what else you can do with the token', () => {
  const use = (over: Partial<RepresentationUseAccessV1> = {}) =>
    ({
      observedAt: '2026-10-03T13:58:00Z',
      pools: {
        state: 'measured',
        blockNumber: 52121000,
        readAt: '2026-10-03T13:00:00Z',
        rows: [
          {
            poolAddress: `0x${'5'.repeat(40)}`,
            venueId: null,
            venueName: null,
            venuePageUrl: null,
            factoryAddress: null,
            tokenBalanceAtomic: '900000000000',
            tokenDecimals: 8,
            pairedTokenAddress: USDC,
            pairedBalanceAtomic: '1',
            pairedDecimals: 6,
            pairedSymbol: null,
          },
          {
            poolAddress: `0x${'6'.repeat(40)}`,
            venueId: 'aerodrome_cl',
            venueName: 'Aerodrome CL',
            venuePageUrl: `https://aerodrome.finance/liquidity?query=0x${'6'.repeat(40)}`,
            factoryAddress: `0x${'7'.repeat(40)}`,
            tokenBalanceAtomic: '229553000000',
            tokenDecimals: 8,
            pairedTokenAddress: USDC,
            pairedBalanceAtomic: '1598344510000',
            pairedDecimals: 6,
            // The stored reading had no symbol for USDC (2026-10-03).
            pairedSymbol: null,
          },
        ],
      },
      defi: {
        checkedVenues: ['morpho', 'aave_v3', 'euler'],
        venues: [
          {
            venueId: 'morpho',
            venueName: 'Morpho',
            state: 'listed',
            uses: { lend: null, borrow: null, collateral: true },
            curated: true,
            marketRef: MARKET,
            reason: null,
            markets: [
              {
                marketId: `0x${'f'.repeat(64)}`,
                curated: false,
                role: 'collateral',
                loanAssetSymbol: 'USDC',
                collateralAssetSymbol: 'NVDAc',
                lltvBps: 7700,
                collateralUsd: 12,
                supplyUsd: 98,
                borrowUsd: 1,
                liquidityUsd: 97,
                supplyApyBps: 0,
                borrowApyBps: 15,
              },
              {
                marketId: MARKET,
                curated: true,
                role: 'collateral',
                loanAssetSymbol: 'USDC',
                collateralAssetSymbol: 'NVDAc',
                lltvBps: 6250,
                collateralUsd: 2486,
                supplyUsd: 854.57,
                borrowUsd: 701.6,
                liquidityUsd: 152.97,
                supplyApyBps: 408,
                borrowApyBps: 499,
              },
            ],
          },
          {
            venueId: 'aave_v3',
            venueName: 'Aave v3',
            state: 'not_listed',
            uses: { lend: null, borrow: null, collateral: null },
            marketRef: null,
            reason: null,
          },
        ],
      },
      ...over,
    }) as unknown as RepresentationUseAccessV1;

  test('the deepest pool a named venue runs, the Morpho market Morpho lists, and Aave as announced', () => {
    const view = stockUsesViewV1({ use: use(), tokenSymbol: 'NVDAc', priceUsd: 234.31, now: NOW })!;
    assert.equal(view.title, 'What else you can do with NVDAc');
    assert.deepEqual(
      view.rows.map((row) => [row.id, row.label, row.text, row.href]),
      [
        [
          'pool',
          'Pool',
          // 2,295.53 NVDAc at $234.31 plus 1,598,344.51 USDC.
          'Aerodrome CL · NVDAc/USDC · about $2.14M in it',
          `https://aerodrome.finance/liquidity?query=0x${'6'.repeat(40)}`,
        ],
        [
          'borrow',
          'Borrow',
          'USDC against NVDAc on Morpho · up to $153 now · 4.99% a year · up to 62.5% of its value',
          `https://app.morpho.org/base/market/${MARKET}`,
        ],
        [
          'earn',
          'Earn',
          'Lend USDC in that Morpho market · 4.08% a year · $855 lent so far',
          `https://app.morpho.org/base/market/${MARKET}`,
        ],
        ['announced', 'Aave', 'Base announced it as collateral on Aug 24 — not live yet', null],
      ],
    );
    assert.equal(view.note, "The venues' own figures, read 2 min ago. Rates move. Nothing here is advice.");
  });

  test('a market anybody deployed never reaches the card, and no price means no dollar size', () => {
    const uncurated = use();
    const morpho = uncurated.defi.venues[0]!;
    (morpho as { markets: unknown }).markets = morpho.markets!.filter((market) => market.curated !== true);
    const view = stockUsesViewV1({ use: uncurated, tokenSymbol: 'NVDAc', priceUsd: null, now: NOW })!;
    assert.deepEqual(view.rows.map((row) => row.id), ['pool', 'announced']);
    assert.equal(view.rows[0]!.text, 'Aerodrome CL · NVDAc/USDC');
  });

  test('nothing read is no block at all, never an empty one', () => {
    assert.equal(stockUsesViewV1({ use: null, tokenSymbol: 'NVDAc', priceUsd: 1, now: NOW }), null);
    const bare = use({ pools: { state: 'not_measured', blockNumber: null, readAt: null, rows: [] }, defi: { checkedVenues: [], venues: [] } });
    // Aave is checked against nothing here, so it is `unchecked`, not "not live".
    assert.equal(stockUsesViewV1({ use: bare, tokenSymbol: 'NVDAc', priceUsd: 1, now: NOW }), null);
  });

  test('a Morpho link is built only from a market id, and sizes read as sizes', () => {
    assert.equal(morphoMarketUrlV1(MARKET), `https://app.morpho.org/base/market/${MARKET}`);
    assert.equal(morphoMarketUrlV1('0xb4b4'), null);
    assert.equal(morphoMarketUrlV1(`javascript:alert(1)`), null);
    assert.equal(compactUsdV1(2_136_200), '$2.14M');
    assert.equal(compactUsdV1(537_900), '$537.9K');
    assert.equal(compactUsdV1(152.97), '$153');
  });
});
