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
import { ConsoleShell } from '../src/console/ConsoleShell';
import { ConsoleMiniShell } from '../src/console/ConsoleMini';

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

// ---------------------------------------------------------------------------
// The frame around the board, for a reader whose `/status` is a 401.
//
// Production, 2026-09-23: "chain unknown · Block — · Gas —" in the header and
// "Block —" in the footer, above a board of real measurements. Nothing was
// broken — the server's chain reading sits behind the session — but a row of
// dashes reads as a dead feed, and it is the first thing a visitor sees.
// ---------------------------------------------------------------------------

function shellMarkupV1(chainRead: boolean | undefined): string {
  return renderToStaticMarkup(
    <ConsoleShell
      header={{
        crumb: ['Stocks'],
        blockNumber: null,
        gasLabel: null,
        ...(chainRead === undefined ? {} : { chainRead }),
        networkLabel: 'Base mainnet · 8453',
        connected: false,
        walletLabel: null,
      }}
      left={{ nav: [], sessions: [], sessionCount: '0', proofs: [], proofCount: '0' }}
      footer={{
        adaptersLabel: '—',
        sourcesLabel: '5',
        spendLabel: '$0',
        blockNumber: null,
        ...(chainRead === undefined ? {} : { chainRead }),
      }}
      right={null}
      theme="dark"
      onThemeChange={() => undefined}
      onNewGoal={() => undefined}
      onSelectSession={() => undefined}
      onSelectProof={() => undefined}
    >
      <div>board</div>
    </ConsoleShell>,
  );
}

test('a visitor’s frame leaves out the chain it could not read', () => {
  const markup = shellMarkupV1(false);
  assert.doesNotMatch(markup, />Block </);
  assert.doesNotMatch(markup, />Gas </);
  // What IS known stays: the chain this build serves, and that no wallet is
  // connected — the one message a visitor must not lose.
  assert.match(markup, /Base mainnet · 8453/);
  assert.match(markup, /not connected/);
});

test('a session frame still says when block and gas are not known right now', () => {
  // Absent means read, or being read: a dash there is a real statement.
  const markup = shellMarkupV1(undefined);
  assert.match(markup, />Block </);
  assert.match(markup, />Gas </);
});

test('the Base App bar leaves out an unread chain the same way', () => {
  const bar = (chainRead: boolean) =>
    renderToStaticMarkup(
      <ConsoleMiniShell
        goalLine="New goal"
        stepLine="Not started"
        networkLabel="chain unknown"
        connected={false}
        blockNumber={null}
        chainRead={chainRead}
        theme="dark"
        onThemeChange={() => undefined}
        drawer={null}
        panels={null}
      >
        <div>board</div>
      </ConsoleMiniShell>,
    );
  assert.doesNotMatch(bar(false), /chain unknown|Block/);
  assert.match(bar(true), /chain unknown/);
});

test('both surfaces tell the board who is reading, and the frame what was read', () => {
  const root = path.resolve(here, '..', '..', '..');
  const source = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
  assert.match(source('lib/ui/src/console/stocksConsole.ts'), /reader: access,/);
  const web = source('artifacts/interface/src/features/rwa/MarketRealityPage.tsx');
  assert.equal(web.match(/chainRead: access === 'session',/g)?.length, 2, 'header and footer both');
  assert.match(web, /chainLabelV1\(status\.data\?\.chainId \?\? \(access === 'public' \? expectedChainId : undefined\)\)/);
  assert.match(
    source('artifacts/miniapp/app/components/MiniConsole.tsx'),
    /chainRead=\{!stocksSignedOut\}/,
  );
});

test('every dossier the board fetches can reach its ladder', () => {
  // Structural, because the failure is a re-render that never happens and SSR
  // renders once. The hooks went from three to five and the memo's dependency
  // list stayed at three; a ladder arriving on the fourth or fifth hook was
  // picked up only when an open quote's tick re-ran the memo, which a visitor
  // never has. NVDA's Coinbase card is the fourth.
  const source = readFileSync(path.join(here, '../src/console/stocksConsole.ts'), 'utf8');
  const hooks = [...source.matchAll(/const (dossier[A-Z]) = useOfficialAssetDossier\(/g)].map((match) => match[1]!);
  assert.equal(hooks.length, 5);
  const memo = source.slice(source.indexOf('const ladders = useMemo('));
  const body = memo.slice(0, memo.indexOf('\n  ]);'));
  const deps = body.slice(body.lastIndexOf('}, ['));
  for (const hook of hooks) {
    assert.ok(body.includes(`${hook}.data,`) || body.includes(`${hook}.data]`), `${hook} is not read by the ladders`);
    assert.ok(deps.includes(`${hook}.data`), `${hook} is read but not a dependency, so its ladder can go unseen`);
  }
});

test('what the card may say about the fee is an offer, never a promise', async () => {
  const { sponsoredFeeNoteV1 } = await import('../src/console/stocksConsole');
  assert.equal(
    sponsoredFeeNoteV1({ sponsoredGas: true, dailyLimitPerWallet: 3 }),
    'Base Account wallets: Miorail offers to pay the network fee, up to 3 trades a day.',
  );
  assert.equal(
    sponsoredFeeNoteV1({ sponsoredGas: true, dailyLimitPerWallet: 1 }),
    'Base Account wallets: Miorail offers to pay the network fee, up to 1 trade a day.',
  );
  assert.equal(sponsoredFeeNoteV1({ sponsoredGas: false, dailyLimitPerWallet: null }), null);
  // The web trades from the card; the Base App, which cannot sign a reader in,
  // keeps its Prepare buttons.
  const root = path.resolve(here, '..', '..', '..');
  const web = readFileSync(path.join(root, 'artifacts/interface/src/features/rwa/MarketRealityPage.tsx'), 'utf8');
  const mini = readFileSync(path.join(root, 'artifacts/miniapp/app/components/MiniConsole.tsx'), 'utf8');
  assert.match(web, /trade: \{\s*sponsoredGas: sponsoredGas\.data\?\.sponsoredGas === 'on',/);
  assert.doesNotMatch(mini, /\btrade: \{|starterBuy/);
});

test('a trade from the card reaches the planner at the typed size, or says why not', () => {
  // Structural: the hook needs a query client these tests do not mount.
  const source = readFileSync(path.join(here, '../src/console/stocksConsole.ts'), 'utf8');
  const action = source.slice(source.indexOf('onTrade: (trade:'));
  const body = action.slice(0, action.indexOf('\n            },'));
  assert.match(body, /stockTradeGoalV1\(\{ \.\.\.trade, response: reality\.data as never, now: new Date\(\) \}\)/);
  // A refusal is a sentence for the card, not a button that does nothing.
  assert.match(body, /if \(built\.status !== 'ready'\) return built\.detail;/);
  // The same floor every reviewed stock trade gets, whichever door.
  assert.match(body, /minimumVerification: STOCK_EXECUTION_VERIFICATION_DEPTH_V1,/);
  assert.match(body, /direction: built\.direction,/);
});
