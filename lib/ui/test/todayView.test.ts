import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  TODAY_REWARDS_QUESTION_V1,
  routeTodayQuestionV1,
  stockNamedV1,
  todayModelV1,
  todayWalletCheckV1,
  type TodayInputV1,
  type TodayRouteV1,
} from '../src/console/todayView';

const STOCKS = [
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation' },
  { symbol: 'A', name: 'Agilent Technologies, Inc.' },
  { symbol: 'FSLR', name: 'First Solar, Inc.' },
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A' },
];
const TOKEN = '0x2a97000000000000000000000000000000008636';
const OFFICIAL = '0xb200000000000000000000c2e324d24d7eecd1fb';

describe('Today hands a question to the page that owns it', () => {
  test('an address anywhere goes to Investigate, lowercased', () => {
    assert.deepEqual(
      routeTodayQuestionV1(`Check this token ${TOKEN.toUpperCase().replace('0X', '0x')}. Can I sell it?`, STOCKS),
      { kind: 'investigate', tokenAddress: TOKEN },
    );
  });

  test('a stock by ticker, by $ticker, by its token, or by name opens its card', () => {
    assert.equal((routeTodayQuestionV1('what is NVDA doing', STOCKS) as { symbol: string }).symbol, 'NVDA');
    assert.equal((routeTodayQuestionV1('buy $aapl', STOCKS) as { symbol: string }).symbol, 'AAPL');
    assert.equal((routeTodayQuestionV1('sell my AAPLc', STOCKS) as { symbol: string }).symbol, 'AAPL');
    assert.equal((routeTodayQuestionV1('сколько стоит Apple сейчас', STOCKS) as { symbol: string }).symbol, 'AAPL');
    assert.equal((routeTodayQuestionV1('news on alphabet', STOCKS) as { symbol: string }).symbol, 'GOOGL');
  });

  test('an English word that is also a ticker is not a stock', () => {
    // "A" is Agilent and "first" begins First Solar; neither was asked about.
    assert.equal(routeTodayQuestionV1('A first question about my rewards', STOCKS).kind, 'wallet');
    assert.equal(stockNamedV1('is this the first time', STOCKS), null);
    assert.equal(stockNamedV1('First Solar', STOCKS)?.symbol, 'FSLR');
  });

  test('rewards and balances go to Wallet MCP, in Russian too', () => {
    assert.deepEqual(routeTodayQuestionV1('What can I claim?', STOCKS), {
      kind: 'wallet',
      question: 'What can I claim?',
    });
    assert.equal(routeTodayQuestionV1('какие награды я могу забрать', STOCKS).kind, 'wallet');
  });

  test('a swap goes to Swap AI as a goal, and nothing else is guessed', () => {
    assert.deepEqual(routeTodayQuestionV1('swap 10 USDC to ETH', STOCKS), {
      kind: 'routes',
      goal: 'swap 10 USDC to ETH',
    });
    assert.equal(routeTodayQuestionV1('обменять ETH на USDC', STOCKS).kind, 'routes');
    assert.equal(routeTodayQuestionV1('hello there', STOCKS).kind, 'unknown');
    assert.equal(routeTodayQuestionV1('   ', STOCKS).kind, 'unknown');
  });
});

describe("what the wallet's balances already say", () => {
  const rows = [
    { symbol: 'ETH', address: 'native', balanceFormatted: '0.0003' },
    { symbol: 'NVDAc', address: OFFICIAL, balanceFormatted: '0.0009', registry: { standing: 'official' as const, ticker: 'NVDAc' } },
    { symbol: 'AAPLc', address: TOKEN, balanceFormatted: '15', possibleSpam: true, registry: { standing: 'lookalike' as const, ticker: 'AAPLc', officialAddress: OFFICIAL } },
    { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', balanceFormatted: '5', verified: true },
    { symbol: 'BOT', address: '0x' + '1'.repeat(40), balanceFormatted: '50' },
    { symbol: 'SPAM', address: '0x' + '2'.repeat(40), balanceFormatted: '1', possibleSpam: true },
    { symbol: 'ZERO', address: '0x' + '3'.repeat(40), balanceFormatted: '0' },
  ];

  test('official, lookalike, unchecked and spam are told apart, and the mark beats the spam flag', () => {
    const check = todayWalletCheckV1(rows);
    assert.deepEqual(check.official.map((row) => row.ticker), ['NVDAc']);
    assert.deepEqual(check.lookalikes.map((row) => [row.symbol, row.officialTicker]), [['AAPLc', 'AAPLc']]);
    // USDC is verified by the provider; ETH is native; ZERO holds nothing.
    assert.deepEqual(check.unchecked.map((row) => row.symbol), ['BOT']);
    assert.equal(check.possibleSpam, 1);
  });

  test('a missing formatted balance keeps the holding visible instead of becoming zero', () => {
    const check = todayWalletCheckV1([
      { symbol: 'NVDAc', address: OFFICIAL, registry: { standing: 'official', ticker: 'NVDAc' } },
      { symbol: 'AAPLc', address: TOKEN, balanceFormatted: null, registry: { standing: 'lookalike', ticker: 'AAPLc' } },
    ]);
    assert.equal(check.official.length, 1);
    assert.equal(check.lookalikes.length, 1);
    assert.equal(check.lookalikes[0]!.balance, null);
  });

  function input(overrides: Partial<TodayInputV1> = {}): { input: TodayInputV1; routed: TodayRouteV1[]; opened: string[] } {
    const routed: TodayRouteV1[] = [];
    const opened: string[] = [];
    return {
      routed,
      opened,
      input: {
        signedIn: true,
        wallet: {
          check: todayWalletCheckV1(rows),
          loading: false,
          failed: false,
          radar: { watches: [], events: [] },
          trackedB20: 0,
        },
        question: 'What can I claim?',
        reply: null,
        stocks: [...STOCKS, { symbol: 'NVDA', name: 'NVIDIA Corporation' }],
        actions: {
          onQuestionChange: () => {},
          onRoute: (route) => routed.push(route),
          onInvestigate: (address) => opened.push(`investigate:${address}`),
          onOpenRadar: () => opened.push('radar'),
          onOpenB20: () => opened.push('b20'),
          onAskWallet: (question) => opened.push(`wallet:${question}`),
          onOpenStock: (symbol) => opened.push(`stock:${symbol}`),
          onSignIn: () => opened.push('signin'),
        },
        ...overrides,
      },
    };
  }

  test('a lookalike leads, in amber, with one button to its evidence', () => {
    const { input: value, opened } = input();
    const model = todayModelV1(value);
    const first = model.wallet!.items[0]!;
    assert.equal(first.title, 'AAPLc in your wallet is not the official AAPLc');
    assert.equal(first.attention, true);
    first.actions[0]!.onClick();
    assert.deepEqual(opened, [`investigate:${TOKEN}`]);
    const lookalikeTile = model.wallet!.tiles.find((tile) => tile.label === 'lookalikes in your wallet')!;
    assert.equal(lookalikeTile.value, '1');
    assert.equal(lookalikeTile.attention, true);
  });

  test('every suggestion is something this wallet has', () => {
    const { input: value, opened } = input();
    const model = todayModelV1(value);
    assert.deepEqual(model.ask.suggestions.map((s) => s.label), ['Is AAPLc real?', TODAY_REWARDS_QUESTION_V1, 'Open NVDA']);
    model.ask.suggestions[2]!.onClick();
    assert.deepEqual(opened, ['stock:NVDA']);
  });

  test('with no watch, the stock you hold is offered to watch', () => {
    const model = todayModelV1(input().input);
    const start = model.wallet!.items.find((item) => item.key === 'radar-start')!;
    assert.equal(start.title, 'Watch the market of NVDAc');
  });

  test('the question is routed on submit, not before', () => {
    const { input: value, routed } = input();
    const model = todayModelV1(value);
    assert.equal(routed.length, 0);
    model.ask.onSubmit();
    assert.deepEqual(routed, [{ kind: 'wallet', question: 'What can I claim?' }]);
  });

  test('a failed balance read says so and claims nothing about the wallet', () => {
    const model = todayModelV1(
      input({ wallet: { check: null, loading: false, failed: true, radar: null, trackedB20: null } }).input,
    );
    assert.match(model.wallet!.unavailable!, /not a statement about what you hold/);
    assert.deepEqual(model.wallet!.tiles, []);
  });

  test('a reader with no session gets the check and a way in, not a wallet', () => {
    const { input: value, opened } = input({ signedIn: false, wallet: null });
    const model = todayModelV1(value);
    assert.equal(model.wallet, null);
    assert.match(model.ask.placeholder, /token address/);
    model.onSignIn!();
    assert.deepEqual(opened, ['signin']);
  });
});
