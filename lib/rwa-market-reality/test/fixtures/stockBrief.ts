import type { RwaSignalFeedV1 } from '@mioagent/rwa-dossier';
import { stockBriefV1 } from '../../src/stockBrief.js';

export const NOW = new Date('2026-09-30T21:00:00.000Z');
export const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
export const OTHER = '0x2222222222222222222222222222222222222222';
export const FEED: RwaSignalFeedV1 = {
  schemaVersion: 'rwa-signal-feed/v1',
  chainId: 8453,
  observedAt: NOW.toISOString(),
  watching: [
    { kind: 'official_asset_multiplier_changed', watchingSince: '2026-09-01T00:00:00.000Z' },
  ],
  corporateActionRecord: null,
  notReported: ['Trades and price movements are not reported here.'],
  cards: [],
};
export function briefInput(): Parameters<typeof stockBriefV1>[0] {
  return {
    now: NOW,
    balanceReadAt: NOW.toISOString(),
    dividends: {
      schemaVersion: 'dividend-wallet/v1' as const,
      generatedAt: NOW.toISOString(),
      blockNumber: 52_000_001,
      holdings: [
        {
          underlyingKey: 'security:isin:US67066G1040',
          symbol: 'NVDA',
          company: 'NVIDIA',
          tokenAddress: TOKEN,
          tokenSymbol: 'NVDAc',
          tokens: '0.000882',
          upcoming: [
            {
              state: 'announced' as const,
              reason: null,
              amountPerShare: '0.25',
              payDate: '2026-10-01',
              payDateApproximate: false,
              kind: 'estimate' as const,
              tokens: '0.000882',
              shares: '0.0000005',
              usd: '0.000113',
              at: null,
            },
          ],
          received: [],
        },
      ],
      receivedUsd: '0',
      passThroughPercent: '51.2',
    },
    tokenAddresses: [TOKEN],
    references: [{ tokenAddress: TOKEN, price: 228.78, at: '2026-09-30T20:50:00.000Z' }],
    controls: new Map([
      [
        TOKEN,
        { multiplierWad: '1000000000000000000', scheduleRead: 'read' as const, schedule: null },
      ],
    ]),
    watchedAddresses: [] as string[],
    changes: FEED,
  };
}
export function briefFixture() {
  return stockBriefV1(briefInput());
}
