import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import url from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  stocksVisitorNoticeV1,
  useStocksConsoleV1,
  type StocksConsoleInputV1,
} from '../src/console/stocksConsole';
import { MarketRealityScreen } from '../src/console/MarketRealityScreen';

// ---------------------------------------------------------------------------
// The Stocks board with no session.
//
// Found 2026-09-22 by rendering miorail.xyz with no wallet: the whole page was
// a sign-in card. The board now reads a public door, and these tests hold the
// three things that make that safe to ship: a public reader is served public
// cache entries only, the controls that spend a session's money lead to the
// wallet instead of to an endpoint, and a ticker in the address selects that
// security or none — never the default one.
// ---------------------------------------------------------------------------

const here = path.dirname(url.fileURLToPath(import.meta.url));

const NVDA = 'security:isin:US67066G1040';
const AAPL = 'security:isin:US0378331005';

function entryV1(underlyingKey: string, displaySymbol: string, canonicalName: string) {
  return {
    underlyingKey,
    canonicalName,
    displaySymbol,
    assetClass: 'equity',
    identifierScheme: 'isin',
    identifierValue: underlyingKey.split(':')[2],
    representationCount: 1,
    liveRepresentationCount: 1,
    issuerIds: ['coinbase'],
    multiIssuer: false,
    coinbaseIssued: true,
  };
}

function indexV1(entries: ReturnType<typeof entryV1>[], scope = 'coinbase_b20') {
  return {
    schemaVersion: 'market-reality-index/v1',
    chainId: 8453,
    scope,
    entries,
    totals: {
      underlyings: entries.length,
      boundRepresentations: entries.length,
      multiIssuerUnderlyings: 0,
      coinbaseUnderlyings: entries.length,
      allUnderlyings: entries.length,
    },
    observedAt: '2026-09-23T10:00:00.000Z',
  };
}

type ProbeV1 = {
  selectedKey: string | null;
  selectedSymbol: string | null;
  visitor: boolean;
  measure: boolean;
  watch: boolean;
  askAvailable: boolean;
  viewError: string | null;
};

function probeV1(
  seed: (client: QueryClient) => void,
  input: Partial<StocksConsoleInputV1>,
): { probe: ProbeV1; markup: string } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  let probe: ProbeV1 | null = null;
  function Probe() {
    const stocks = useStocksConsoleV1({
      question: {
        underlyingKey: null,
        direction: 'sell',
        requestedCashAtomic: '1000000000',
        destination: 'USDC',
        surface: 'market',
        historyPeriod: 'now',
      },
      enabled: true,
      configurationRead: true,
      onQuestion: () => {},
      ...input,
    });
    probe = {
      selectedKey: stocks.selectedKey,
      selectedSymbol: stocks.selectedSymbol,
      visitor: Boolean(stocks.model.visitor),
      measure: typeof stocks.model.actions.onMeasure === 'function',
      watch: typeof stocks.model.actions.onWatch === 'function',
      askAvailable: Boolean(stocks.model.ask?.available),
      viewError: stocks.model.viewError,
    };
    return <MarketRealityScreen model={stocks.model} />;
  }
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return { probe: probe!, markup };
}

test('a public reader is served the public cache entry, never the session one', () => {
  const { probe } = probeV1(
    (client) => {
      // Two different corpora under the two keys: whichever the hook reads is
      // the one it selects from.
      client.setQueryData(['rwa-underlyings', 100, null, 'public'], indexV1([entryV1(NVDA, 'NVDA', 'NVDA')]));
      client.setQueryData(['rwa-underlyings', 100, null, 'session'], indexV1([entryV1(AAPL, 'AAPL', 'Apple Inc.')]));
    },
    { access: 'public' },
  );
  assert.equal(probe.selectedKey, NVDA);
});

test('a ticker in the address selects that security, not the default one', () => {
  const { probe } = probeV1(
    (client) =>
      client.setQueryData(
        ['rwa-underlyings', 100, null, 'public'],
        indexV1([entryV1(AAPL, 'AAPL', 'Apple Inc.'), entryV1(NVDA, 'NVDA', 'NVDA')]),
      ),
    { access: 'public', preferredSymbol: 'nvda' },
  );
  assert.equal(probe.selectedKey, NVDA);
  assert.equal(probe.selectedSymbol, 'NVDA');
});

test('a ticker the corpus does not hold selects nothing and says whose statement that is', () => {
  const { probe } = probeV1(
    (client) => {
      const index = indexV1([entryV1(AAPL, 'AAPL', 'Apple Inc.')], 'all_representations');
      // The hook widens to the whole corpus before saying "not held"; seed the
      // wide read so the answer is final.
      client.setQueryData(['rwa-underlyings', 100, null, 'public'], index);
      client.setQueryData(['rwa-underlyings', 100, 'all_representations', 'public'], index);
    },
    { access: 'public', preferredSymbol: 'zzzz' },
  );
  assert.equal(probe.selectedKey, null, 'a link to one stock must never open on another');
  assert.match(String(probe.viewError), /no reviewed security under the ticker ZZZZ/);
  assert.match(String(probe.viewError), /statement about Miorail’s corpus/);
});

test('signed out, the session-only controls lead to the wallet when there is a door', () => {
  const signIns: number[] = [];
  const { probe, markup } = probeV1(
    (client) =>
      client.setQueryData(['rwa-underlyings', 100, null, 'public'], indexV1([entryV1(NVDA, 'NVDA', 'NVDA')])),
    { access: 'public', onSignInRequired: () => signIns.push(1) },
  );
  assert.equal(probe.visitor, true);
  assert.equal(probe.measure, true);
  assert.equal(probe.watch, true);
  assert.equal(probe.askAvailable, true);
  assert.match(markup, /Reading without a wallet/);
  assert.match(markup, />Connect wallet</);
});

test('signed out with no door, those controls are absent rather than inert', () => {
  const { probe, markup } = probeV1(
    (client) =>
      client.setQueryData(['rwa-underlyings', 100, null, 'public'], indexV1([entryV1(NVDA, 'NVDA', 'NVDA')])),
    { access: 'public' },
  );
  assert.equal(probe.visitor, true);
  assert.equal(probe.measure, false);
  assert.equal(probe.watch, false);
  assert.equal(probe.askAvailable, false);
  assert.doesNotMatch(markup, />Connect wallet</);
});

test('a session reader gets no visitor notice and the full set of controls', () => {
  const { probe } = probeV1(
    (client) =>
      client.setQueryData(['rwa-underlyings', 100, null, 'session'], indexV1([entryV1(NVDA, 'NVDA', 'NVDA')])),
    {},
  );
  assert.equal(probe.visitor, false);
  assert.equal(probe.selectedKey, NVDA);
  assert.equal(probe.measure, true);
  assert.equal(probe.askAvailable, true);
});

test('the notice names what a visitor cannot do yet, so nothing looks broken', () => {
  const notice = stocksVisitorNoticeV1(() => {});
  assert.match(notice.body, /measure again now, watch a price, or buy and sell/);
  assert.match(notice.body, /each with its age/);
  assert.equal(notice.action, 'Connect wallet');
  assert.equal(stocksVisitorNoticeV1().onSignIn, undefined);
});

test('nothing a session pays for is started without one', () => {
  // Structural, because these are effects and SSR runs none: the radar, the
  // pool's spot read and the automatic measurement are each gated on the
  // session, not merely on `enabled`.
  const source = readFileSync(path.join(here, '../src/console/stocksConsole.ts'), 'utf8');
  assert.match(source, /useMarketRealityRadar\(\{ enabled: enabled && session \}\)/);
  assert.match(source, /enabled: enabled && session && question\.surface !== 'utility'/);
  assert.match(source, /if \(!enabled \|\| !session \|\| !selectedKey \|\| !questionKey\) return;/);
  // And every read the public door serves is asked through it.
  for (const read of [
    'useRwaUnderlyings({ enabled, scope: scope ?? undefined, access })',
    '{ enabled, access }',
    'useOfficialAssetDossier(representationAddresses[0] ?? null, { access })',
    'useRwaUseAccess(representationAddresses[0] ?? null, { enabled: useAccessEnabled, access })',
  ]) {
    assert.ok(source.includes(read), `missing: ${read}`);
  }
});
