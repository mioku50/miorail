import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ReopenGameResponseV1 } from '@mioagent/rwa-market-reality/reopen-game';

import { ReopenGameCard } from '../src/console/ReopenGameCard';
import { countdownV1, reopenGameViewV1 } from '../src/console/reopenGameView';

// The test runner compiles JSX with the classic transform: React.createElement.
void React;

const ORIGIN = 'https://miorail.xyz';
const LOCKS = '2026-10-11T21:00:00.000Z';
const OPENS = '2026-10-10T00:00:00.000Z';
const REOPEN = '2026-10-12T00:00:00.000Z';

const stock = (symbol: string, over: Record<string, unknown> = {}) => ({
  tokenAddress: `0xb2${String(symbol.length).padStart(38, '0')}`,
  symbol,
  name: `${symbol} Inc.`,
  close: '100.00',
  baseNow: { value: '101.00', moveBps: 100 },
  baseCall: null,
  crowd: null,
  result: null,
  ...over,
});

function game(over: Partial<ReopenGameResponseV1> = {}): ReopenGameResponseV1 {
  return {
    schemaVersion: 'call-the-reopen/v1',
    generatedAt: '2026-10-10T16:00:00.000Z',
    round: {
      roundId: '2026-10-09',
      number: 1,
      state: 'open',
      opensAt: OPENS,
      locksAt: LOCKS,
      expectedReopenAt: REOPEN,
      stocks: [stock('NVDA'), stock('TSLA')],
      players: null,
      score: null,
    },
    next: { number: 2, opensAt: '2026-10-17T00:00:00.000Z', locksAt: '2026-10-18T21:00:00.000Z', expectedReopenAt: '2026-10-19T00:00:00.000Z' },
    baseRecord: { rounds: 0, correct: 0, of: 0 },
    me: null,
    ...over,
  };
}

const NOW = new Date('2026-10-10T16:00:00.000Z');
const record = { played: 0, streak: 0, correct: 0, of: 0, beatBase: 0 };

describe('the leaderboard', () => {
  const board = (over: Record<string, unknown> = {}) => ({
    rounds: 2,
    players: 14,
    rows: [
      { rank: 1, name: 'first.base.eth', correct: 9, of: 10, played: 2, you: false },
      { rank: 2, name: 'Player 7', correct: 8, of: 10, played: 2, you: false },
      { rank: 2, name: 'Player 3', correct: 8, of: 10, played: 2, you: true },
    ],
    me: { rank: 2, correct: 8, of: 10, played: 2 },
    ...over,
  });

  test('names a Basename or a number, marks the reader, and says how it ranks', () => {
    const view = reopenGameViewV1(game({ leaderboard: board() }), { now: NOW, origin: ORIGIN })!;
    assert.equal(
      view.leaderboard?.note,
      'After 2 rounds · 14 players. Most right first. A wallet with a Basename is listed by it; everyone else by player number.',
    );
    assert.deepEqual(view.leaderboard?.rows.map((row) => [row.rank, row.name, row.score, row.rounds]), [
      ['#1', 'first.base.eth', '9/10', '2'],
      ['#2', 'Player 7', '8/10', '2'],
      ['#2', 'Player 3 · you', '8/10', '2'],
    ]);
    assert.equal(view.leaderboard?.me, null, 'the reader is already in the rows');
    assert.deepEqual(view.leaderboard?.rows.map((row) => row.medal), ['🥇', '🥈', '🥈'], 'a shared rank shares the medal');
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view }} />);
    assert.match(html, /<tr class="you"><td class="mono" title="#2">🥈<\/td><td class="nm">Player 3 · you<\/td>/);
    assert.doesNotMatch(html, /0x[0-9a-f]{4}/i, 'no address on the board');
  });

  test('a reader below the rows gets their own line, and no table before a round settles', () => {
    const below = reopenGameViewV1(
      game({ leaderboard: board({ rows: board().rows.slice(0, 2), me: { rank: 14, correct: 2, of: 10, played: 2 } }) }),
      { now: NOW, origin: ORIGIN },
    )!;
    assert.equal(below.leaderboard?.me, 'You: #14 of 14 · 2/10 right over 2 rounds.');
    assert.equal(reopenGameViewV1(game({ leaderboard: null }), { now: NOW, origin: ORIGIN })!.leaderboard, null);
    // A server that predates the table sends no field at all.
    const older = game();
    delete (older as { leaderboard?: unknown }).leaderboard;
    assert.equal(reopenGameViewV1(older, { now: NOW, origin: ORIGIN })!.leaderboard, null);
  });
});

describe('Call the reopen, in words', () => {
  test('before the first round: when it opens and what it asks, and nothing to press', () => {
    const view = reopenGameViewV1(game({ round: null, next: { number: 1, opensAt: OPENS, locksAt: LOCKS, expectedReopenAt: REOPEN } }), {
      now: new Date('2026-10-07T15:00:00.000Z'),
      origin: ORIGIN,
    })!;
    assert.equal(view.state, 'upcoming');
    assert.match(view.lede, /^Round #1 opens Fri 20:00 ET, when Wall Street closes for the weekend/);
    assert.deepEqual(view.clock, { until: OPENS, left: '2 d 9 h', label: 'until round #1 opens', at: 'Fri 20:00 ET' });
    assert.deepEqual(view.steps.map((step) => step.state), ['now', 'next', 'next']);
    assert.match(view.lede, /Picks close Sun 17:00 ET, and Base makes its own call at the same minute\./);
    assert.deepEqual(view.rows, []);
    assert.doesNotMatch(renderToStaticMarkup(<ReopenGameCard model={{ view }} />), /<button/);
  });

  test('open: Base now beside the close, two plain buttons per stock, and no wallet needed', () => {
    const view = reopenGameViewV1(game(), { now: NOW, origin: ORIGIN })!;
    assert.equal(view.badge, 'Picks open');
    assert.match(view.lede, /Picks close Sun 17:00 ET\. At that minute/);
    assert.doesNotMatch(view.lede, /\(in /, 'the countdown is the one clock on the card');
    assert.deepEqual(view.clock, { until: LOCKS, left: '1 d 5 h', label: 'until picks close', at: 'Sun 17:00 ET' });
    assert.deepEqual(
      view.steps.map((step) => [step.label, step.at, step.state]),
      [
        ['Picks open', 'Fri 20:00 ET', 'done'],
        ['Picks close, Base calls', 'Sun 17:00 ET', 'now'],
        ['Wall Street reopens', 'Sun 20:00 ET', 'next'],
      ],
    );
    assert.deepEqual(view.tiles, [{ key: 'mine', label: 'Your calls', value: '0 of 2', detail: 'no wallet needed', progress: 0 }]);
    assert.equal(view.verdict, null);
    assert.equal(view.rows[0]?.baseNow, '$101.00 · +1.00%');
    assert.equal(view.standing, 'Pick ▲ or ▼ for each stock. No wallet needed; you can change a pick until the lock.');
    assert.equal(view.share, null, 'nothing to share before a pick');
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view, onPick: () => undefined }} />);
    assert.match(html, /<div class="mr-scope-switch" role="group" aria-label="NVDA: above or below Friday&#x27;s close">/);
    assert.match(html, /<button type="button" aria-pressed="false">▲ Above<\/button>/);
    // Up and down wear no colour: no tone, no good or bad.
    assert.doesNotMatch(html, /data-tone="(good|bad|warn)"/);
    assert.doesNotMatch(html, /class="pill g"|data-mark=/);
    assert.match(html, /<span class="amount">1 d 5 h<\/span>/);
    assert.match(html, /<div role="listitem" class="st now" aria-current="step"><div class="n">Picks close, Base calls<\/div>/);
  });

  test('the countdown reads in days, hours and minutes, and stops at the moment', () => {
    const at = (ms: number) => countdownV1(new Date(Date.parse(LOCKS) + ms).toISOString(), new Date(LOCKS));
    assert.equal(at(30_000), '1 min');
    assert.equal(at(45 * 60_000), '45 min');
    assert.equal(at(60 * 60_000), '1 h');
    assert.equal(at(110 * 60_000), '1 h 50 min');
    assert.equal(at(48 * 3_600_000), '2 d');
    assert.equal(at(53 * 3_600_000), '2 d 5 h');
    assert.equal(at(0), null);
    assert.equal(at(-60_000), null);
  });

  test('a stock wears its icon, and a picked row and the pressed side wear the brand', () => {
    const address = stock('NVDA').tokenAddress;
    const view = reopenGameViewV1(
      game({ me: { picks: { NVDA: 'down' }, pickedAt: NOW.toISOString(), score: null, record, signed: false } }),
      { now: NOW, origin: ORIGIN, icons: new Map([[address, `/api/public/stocks/icons/${address}.png`]]) },
    )!;
    assert.equal(view.rows[0]?.icon, `/api/public/stocks/icons/${address}.png`);
    assert.deepEqual(view.tiles[0], { key: 'mine', label: 'Your calls', value: '1 of 2', detail: 'yours to change until the lock', progress: 0.5 });
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view, onPick: () => undefined }} />);
    assert.match(html, /<li class="mr-reopen-row" data-picked="true"><div class="mr-reopen-stock"><img class="mr-choice-icon" src="\/api\/public\/stocks\/icons\/0x/);
    assert.match(html, /<button type="button" aria-pressed="true" class="on">▼ Below<\/button>/);
    assert.match(html, /<span class="usebar" aria-hidden="true"><span style="width:50%"><\/span><\/span>/);
  });

  test('a device that picked is told the picks live on it, and offered a wallet', () => {
    const view = reopenGameViewV1(
      game({ me: { picks: { NVDA: 'up' }, pickedAt: NOW.toISOString(), score: null, record, signed: false } }),
      { now: NOW, origin: ORIGIN },
    )!;
    assert.equal(view.rows[0]?.pick, 'up');
    assert.equal(view.keepWithWallet, true);
    assert.match(view.standing ?? '', /kept on this device only/);
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view, onPick: () => undefined, onSignIn: () => undefined }} />);
    assert.match(html, /<button type="button" aria-pressed="true" class="on">▲ Above<\/button>/);
    assert.match(html, />Sign in to keep your streak</);
    assert.match(decodeURIComponent(view.share!.x), /I'm calling the reopen against Base, #1: NVDA ▲\. Picks close Sun 17:00 ET\./);
  });

  test('a pick being sent shows as made', () => {
    const view = reopenGameViewV1(
      game({ me: { picks: { NVDA: 'up' }, pickedAt: NOW.toISOString(), score: null, record, signed: true } }),
      { now: NOW, origin: ORIGIN, pending: { NVDA: 'down', TSLA: 'up' } },
    )!;
    assert.deepEqual(view.rows.map((row) => row.pick), ['down', 'up']);
    assert.equal(view.standing, 'Your picks are kept with your wallet.');
    assert.equal(view.keepWithWallet, false);
  });

  test('locked: Base’s call and how players split, and nothing left to press', () => {
    const round = game().round!;
    const view = reopenGameViewV1(
      game({
        round: {
          ...round,
          state: 'locked',
          players: 3,
          stocks: [
            stock('NVDA', { baseNow: null, baseCall: { base: '101.00', call: 'up' }, crowd: { up: 2, down: 1 } }),
            stock('TSLA', { baseNow: null, baseCall: { base: null, call: null }, crowd: { up: 0, down: 3 } }),
          ],
        },
      }),
      { now: new Date('2026-10-11T22:00:00.000Z'), origin: ORIGIN },
    )!;
    assert.equal(view.badge, 'Picks closed');
    assert.match(view.lede, /^Picks closed Sun 17:00 ET, with 3 players\. Base's calls are in\./);
    assert.deepEqual(view.rows.map((row) => [row.baseCall, row.crowd]), [
      ['▲ at $101.00', '2 ▲ · 1 ▼'],
      ['no call: too few quotes', '0 ▲ · 3 ▼'],
    ]);
    assert.deepEqual(view.clock, { until: REOPEN, left: '2 h', label: 'until Wall Street reopens', at: 'Sun 20:00 ET' });
    assert.deepEqual(view.steps.map((step) => step.state), ['done', 'done', 'now']);
    assert.deepEqual(
      view.tiles.map((tile) => [tile.label, tile.value, tile.detail]),
      [
        ['Players', '3', 'made a call'],
        ['Your calls', 'None', 'you sat this one out'],
        ["Base's calls", '1 of 2', 'from its price at the lock'],
      ],
    );
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view, onPick: () => undefined }} />);
    assert.doesNotMatch(html, /aria-pressed/);
    assert.match(html, /No pick/);
  });

  test('settled: the score against Base and the players, the squares, and the line to share', () => {
    const round = game().round!;
    const results = {
      NVDA: { reopen: '102.00', at: REOPEN, outcome: 'up' as const },
      TSLA: { reopen: '100.00', at: REOPEN, outcome: 'void' as const },
    };
    const view = reopenGameViewV1(
      game({
        round: {
          ...round,
          state: 'settled',
          players: 12,
          stocks: [
            stock('NVDA', { baseNow: null, baseCall: { base: '99.00', call: 'down' }, crowd: { up: 8, down: 4 }, result: results.NVDA }),
            stock('TSLA', { baseNow: null, baseCall: { base: '101.00', call: 'up' }, crowd: { up: 6, down: 6 }, result: results.TSLA }),
          ],
          score: { base: { correct: 0, of: 1, cells: '🟥⬜' }, crowd: { correct: 1, of: 1, cells: '🟩⬜' } },
        },
        me: {
          picks: { NVDA: 'up', TSLA: 'down' },
          pickedAt: NOW.toISOString(),
          score: { correct: 1, of: 1, cells: '🟩⬜' },
          record: { played: 1, streak: 1, correct: 1, of: 1, beatBase: 1 },
          signed: true,
        },
      }),
      { now: new Date('2026-10-12T02:00:00.000Z'), origin: ORIGIN },
    )!;
    assert.equal(view.badge, 'Results');
    assert.equal(view.lede, '12 people played. Round #2 opens Fri 20:00 ET.');
    assert.deepEqual(
      view.tiles.map((tile) => [tile.label, tile.value, tile.detail]),
      [
        ['You', '1/1', '🟩⬜'],
        ['Base', '0/1', '🟥⬜'],
        ['Players', '1/1', '🟩⬜'],
      ],
    );
    assert.deepEqual(view.verdict, { text: 'You beat Base 🎉', tone: 'won' });
    assert.deepEqual(view.steps.map((step) => step.state), ['done', 'done', 'done']);
    assert.equal(view.clock?.label, 'until round #2 opens');
    const settledHtml = renderToStaticMarkup(<ReopenGameCard model={{ view }} />);
    assert.match(settledHtml, /<li class="mr-reopen-row" data-mark="right">/);
    assert.match(settledHtml, /<li class="mr-reopen-row" data-mark="void">/);
    assert.match(settledHtml, /<p class="mr-reopen-verdict"><span class="pill g">You beat Base 🎉<\/span><\/p>/);
    assert.deepEqual(view.rows.map((row) => [row.mark, row.result]), [
      ['🟩', 'Reopened above · $102.00'],
      ['⬜', 'Reopened at the close · $100.00'],
    ]);
    assert.equal(view.standing, 'Streak 1 weekend · 1/1 right overall · beat Base 1 time.');
    assert.match(decodeURIComponent(view.share!.x), /text=Call the reopen #1 🟩⬜ 1\/1 · Base 0\/1&url=https:\/\/miorail\.xyz\/stocks\/weekend$/);

    // With a code, the post links to this result, whose page previews as its picture.
    const coded = reopenGameViewV1(
      game({
        round: { ...round, state: 'settled', players: 12, stocks: [stock('NVDA', { baseNow: null, result: results.NVDA })], score: { base: { correct: 0, of: 1, cells: '🟥' }, crowd: null } },
        me: {
          picks: { NVDA: 'up' },
          pickedAt: NOW.toISOString(),
          score: { correct: 1, of: 1, cells: '🟩' },
          record: { played: 1, streak: 1, correct: 1, of: 1, beatBase: 1 },
          signed: true,
          share: 'Ab3_x-9Zq0Lm',
        },
      }),
      { now: new Date('2026-10-12T02:00:00.000Z'), origin: ORIGIN },
    )!;
    assert.match(decodeURIComponent(coded.share!.x), /&url=https:\/\/miorail\.xyz\/stocks\/weekend\?call=Ab3_x-9Zq0Lm$/);
  });
});

describe('after a pick, one way to the stock itself', () => {
  const picked = { picks: { TSLA: 'down' as const }, pickedAt: NOW.toISOString(), score: null, record, signed: true };

  test('the same stock whatever was picked, and only once something was', () => {
    assert.equal(reopenGameViewV1(game(), { now: NOW, origin: ORIGIN })!.cta, null, 'nothing before a pick');
    const view = reopenGameViewV1(game({ me: picked }), { now: NOW, origin: ORIGIN })!;
    assert.deepEqual(view.cta, { label: 'A piece of NVIDIA, from $1', symbol: 'NVDA', href: '/stocks/nvda' });
    const locked = reopenGameViewV1(game({ round: { ...game().round!, state: 'locked' }, me: picked }), {
      now: new Date('2026-10-11T22:00:00.000Z'),
      origin: ORIGIN,
    })!;
    assert.equal(locked.cta?.symbol, 'NVDA', 'the pick was TSLA down; the way out is still NVIDIA');
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view, onPick: () => undefined }} />);
    assert.match(html, /<p class="mr-reopen-cta"><a class="btn sec" href="\/stocks\/nvda">A piece of NVIDIA, from \$1<\/a><\/p>/);
  });
});

describe('the close is named by its day', () => {
  test('before a holiday Friday the round asks about Thursday\u2019s close', () => {
    // Christmas Eve 2026: the close is Thursday's, at 13:00 ET.
    const thursday = game({
      round: { ...game().round!, roundId: '2026-12-24', opensAt: '2026-12-25T01:00:00.000Z', locksAt: '2026-12-27T22:00:00.000Z', expectedReopenAt: '2026-12-28T01:00:00.000Z' },
    });
    const view = reopenGameViewV1(thursday, { now: new Date('2026-12-26T15:00:00.000Z'), origin: ORIGIN })!;
    assert.deepEqual(view.closeDay, { long: 'Thursday', short: 'Thu' });
    assert.match(view.lede, /^Will each stock reopen above or below Thursday's close\?/);
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view, onPick: () => undefined }} />);
    assert.match(html, /aria-label="NVDA: above or below Thursday&#x27;s close"/);
    assert.match(html, /<span>Thu \$100\.00<\/span>/);
    const upcoming = reopenGameViewV1(
      game({ round: null, next: { number: 9, opensAt: '2026-12-25T01:00:00.000Z', locksAt: '2026-12-27T22:00:00.000Z', expectedReopenAt: '2026-12-28T01:00:00.000Z' } }),
      { now: new Date('2026-12-22T15:00:00.000Z'), origin: ORIGIN },
    )!;
    assert.match(upcoming.lede, /will it reopen above or below Thursday's close\?/);
  });
});
