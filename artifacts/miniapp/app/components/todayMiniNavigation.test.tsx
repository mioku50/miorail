import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CONSOLE_MINIAPP_SECTIONS_V1,
  ConsoleMiniShell,
  TodayScreen,
  consoleNavModelV1,
  routeTodayQuestionV1,
  todayModelV1,
  todayWalletCheckV1,
  type TodayInputV1,
} from '@mioagent/ui';
import {
  miniTodayDraftFromSearchV1,
  miniTodayHandoffV1,
  miniTodayHomeSectionV1,
  miniTodaySessionReadyV1,
} from './todayMiniNavigation';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const mounted = [...CONSOLE_MINIAPP_SECTIONS_V1, 'radar', 'portfolio', 'settings'] as const;

test('Today requires a matching Base session, not a successful status read or a connected wallet alone', () => {
  assert.equal(miniTodaySessionReadyV1({ walletAddress: WALLET, walletChainId: 8453 }), false);
  const sessionUser = { address: WALLET.toUpperCase(), chainId: 8453 };
  assert.equal(miniTodaySessionReadyV1({ walletAddress: WALLET, walletChainId: 8453, sessionUser }), true);
  assert.equal(miniTodaySessionReadyV1({ walletAddress: OTHER, walletChainId: 8453, sessionUser }), false);
  assert.equal(miniTodaySessionReadyV1({ walletChainId: 8453, sessionUser }), false);
  assert.equal(miniTodaySessionReadyV1({ walletAddress: WALLET, walletChainId: 84532, sessionUser }), false);
  assert.equal(miniTodaySessionReadyV1({ walletAddress: WALLET, walletChainId: 8453, sessionUser: { ...sessionUser, chainId: 84532 } }), false);
});

test('a first signed-in visit opens Today, a guest opens Stocks, and every saved page resumes', () => {
  assert.equal(miniTodayHomeSectionV1({ stored: null, mounted, signedIn: true }), 'today');
  assert.equal(miniTodayHomeSectionV1({ stored: null, mounted, signedIn: false }), 'market');
  for (const stored of mounted) {
    assert.equal(miniTodayHomeSectionV1({ stored, mounted, signedIn: true }), stored);
    assert.equal(miniTodayHomeSectionV1({ stored, mounted, signedIn: false }), stored);
  }
  assert.equal(miniTodayHomeSectionV1({ stored: 'investigate', mounted, signedIn: true }), 'today');
});

test('a token question always opens its public exact-address evidence in Base App', () => {
  const route = routeTodayQuestionV1(`Проверь ${OTHER}`, []);
  assert.equal(route.kind, 'investigate');
  for (const signedIn of [true, false]) {
    assert.deepEqual(miniTodayHandoffV1(route, signedIn), {
      kind: 'navigate', href: `/is-it-real/${OTHER}`,
    });
  }
});

test('stock questions preserve the symbol for the shared Stocks resolver', () => {
  const route = routeTodayQuestionV1('Что с NVIDIA?', [{ symbol: 'NVDA', name: 'NVIDIA Corporation' }]);
  assert.equal(route.kind, 'stock');
  assert.deepEqual(miniTodayHandoffV1(route, true), { kind: 'stock', symbol: 'NVDA' });
  assert.deepEqual(miniTodayHandoffV1(route, false), { kind: 'stock', symbol: 'NVDA' });
});

test('wallet and swap questions become drafts, with sign-in preserving a guest question', () => {
  const routes = [
    { kind: 'wallet' as const, question: 'Какие награды я могу забрать?' },
    { kind: 'routes' as const, goal: 'swap 10 USDC to ETH' },
  ];
  for (const route of routes) {
    assert.deepEqual(miniTodayHandoffV1(route, true), route);
    const guest = miniTodayHandoffV1(route, false);
    assert.equal(guest.kind, 'navigate');
    if (guest.kind !== 'navigate') assert.fail('guest must sign in');
    const signIn = new URL(guest.href, 'https://example.com');
    assert.equal(signIn.pathname, '/signin');
    const next = new URL(signIn.searchParams.get('next')!, signIn.origin);
    assert.equal(next.pathname, '/app');
    assert.deepEqual(miniTodayDraftFromSearchV1(next.search), route);
  }
});

test('a custom Base App path survives sign-in, while old non-question queries add no draft', () => {
  const handoff = miniTodayHandoffV1({ kind: 'wallet', question: 'my balances' }, false, '/wallet-app');
  assert.equal(handoff.kind, 'navigate');
  if (handoff.kind !== 'navigate') assert.fail('guest must sign in');
  const next = new URL(new URL(handoff.href, 'https://example.com').searchParams.get('next')!, 'https://example.com');
  assert.equal(next.pathname, '/wallet-app');
  assert.equal(miniTodayDraftFromSearchV1('?ref=old-link&key=security%3Aisin%3ATEST'), null);
  assert.equal(miniTodayDraftFromSearchV1('?goal=%20&ask=%20'), null);
  assert.equal(miniTodayDraftFromSearchV1(`?goal=${'a'.repeat(501)}`), null);
});

function screenV1(signedIn: boolean): string {
  const nothing = () => undefined;
  const actions: TodayInputV1['actions'] = {
    onQuestionChange: nothing, onRoute: nothing, onInvestigate: nothing,
    onOpenRadar: nothing, onOpenB20: nothing, onAskWallet: nothing,
    onOpenStock: nothing, onSignIn: nothing,
  };
  const model = todayModelV1({
    signedIn,
    wallet: {
      check: todayWalletCheckV1([
        { symbol: 'AAPLc', address: OTHER, balanceFormatted: '2', registry: { standing: 'lookalike', ticker: 'AAPLc', officialAddress: WALLET } },
      ]),
      loading: false, failed: false, radar: null, trackedB20: null,
    },
    question: '', reply: null, stocks: [], actions,
  });
  return renderToStaticMarkup(<ConsoleMiniShell
    section="today" goalLine="Today" networkLabel="Base mainnet"
    connected={false} blockNumber={null} theme="dark" onThemeChange={nothing}
    drawer={null} panels={null}
    nav={consoleNavModelV1({ mounted: CONSOLE_MINIAPP_SECTIONS_V1, active: 'today' })}
  ><TodayScreen model={{ ...model, stocksToday: null }} /></ConsoleMiniShell>);
}

test('the four-tab mini shell renders shared Today findings only for a proven session', () => {
  const signed = screenV1(true);
  assert.match(signed, /aria-current="page">Today<\/button>/);
  assert.match(signed, /AAPLc/);
  assert.match(signed, /Worth your attention/);
  const guest = screenV1(false);
  assert.doesNotMatch(guest, /AAPLc|Worth your attention/);
  assert.match(guest, /Is it the real one, and can you sell it/);
  for (const label of ['Stocks', 'Swap AI', 'Wallet MCP']) assert.ok(guest.includes(label));
});

test('MiniConsole mounts the shared hook only with Today, and its handoff cannot execute', () => {
  const source = readFileSync(new URL('./MiniConsole.tsx', import.meta.url), 'utf8');
  const todayComponent = source.slice(source.indexOf('function MiniTodayScreen('), source.indexOf('export function MiniConsole('));
  assert.match(todayComponent, /useTodayConsoleV1\(input\)/);
  assert.match(todayComponent, /<TodayScreen model=\{model\}/);
  assert.match(source, /section === "today"[\s\S]*?<MiniTodayScreen input=\{todayInput\}/);
  assert.match(source, /useSession\(\{ retry: false, staleTime: 0 \}\)/);
  assert.match(source, /signedIn: todaySignedIn/);
  assert.match(source, /usePortfolio\(address, \{ enabled: todaySignedIn && Boolean\(address\) \}\)/);
  assert.match(source, /const stocksSignedOut = !todaySignedIn/);
  assert.match(source, /enabled: sectionReady && section === "market" && \(stocksSignedOut \|\| routeIntelligenceOn\)/);
  const handoff = source.slice(source.indexOf('const applyTodayHandoff ='), source.indexOf('const todayInput:'));
  assert.doesNotMatch(handoff, /\.mutate|sendCalls|signMessage|signTransaction|fetch\(/);
  assert.match(handoff, /setBaseMcpQuestion\(handoff\.question\)/);
  assert.match(handoff, /setGoal\(handoff\.goal\)/);
  assert.match(handoff, /underlyingKey: null/);
  assert.match(source, /preferredSymbol: stocksSymbol/);
  assert.match(source, /useState<ConsoleSectionV1>\("market"\)/);
  assert.match(source, /sectionRestored\.current \|\| session\.isPending \|\| isReconnecting/);
  assert.match(source, /const navigateSection =[\s\S]*?sectionRestored\.current = true;[\s\S]*?setSection\(next\)/);
  assert.match(source, /onNavigate=\{navigateSection\}/);
});
