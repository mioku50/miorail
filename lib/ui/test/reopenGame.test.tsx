import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ReopenGameResponseV1 } from '@mioagent/rwa-market-reality/reopen-game';

import { ReopenGameCard } from '../src/console/ReopenGameCard';
import { reopenGameViewV1 } from '../src/console/reopenGameView';

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
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view }} />);
    assert.match(html, /<tr class="you"><td class="mono">#2<\/td><td class="nm">Player 3 · you<\/td>/);
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
    assert.match(view.lede, /^Round #1 opens Fri 20:00 ET \(in 2 days\), when Wall Street closes for the weekend/);
    assert.match(view.lede, /Picks close Sun 17:00 ET, and Base makes its own call at the same minute\./);
    assert.deepEqual(view.rows, []);
    assert.doesNotMatch(renderToStaticMarkup(<ReopenGameCard model={{ view }} />), /<button/);
  });

  test('open: Base now beside the close, two plain buttons per stock, and no wallet needed', () => {
    const view = reopenGameViewV1(game(), { now: NOW, origin: ORIGIN })!;
    assert.equal(view.badge, 'Picks open');
    assert.match(view.lede, /Picks close Sun 17:00 ET \(in 29 h\)\./);
    assert.equal(view.rows[0]?.baseNow, '$101.00 · +1.00%');
    assert.equal(view.standing, 'Pick ▲ or ▼ for each stock. No wallet needed; you can change a pick until the lock.');
    assert.equal(view.share, null, 'nothing to share before a pick');
    const html = renderToStaticMarkup(<ReopenGameCard model={{ view, onPick: () => undefined }} />);
    assert.match(html, /<div class="mr-scope-switch" role="group" aria-label="NVDA: above or below Friday&#x27;s close">/);
    assert.match(html, /<button type="button" aria-pressed="false">▲ Above<\/button>/);
    // Up and down wear no colour: no tone, no good or bad.
    assert.doesNotMatch(html, /data-tone="(good|bad|warn)"/);
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
    assert.equal(view.lede, 'You 1/1 · Base 0/1 · players 1/1. 12 people played. Round #2 opens Fri 20:00 ET (in 5 days).');
    assert.deepEqual(view.rows.map((row) => [row.mark, row.result]), [
      ['🟩', 'Reopened above · $102.00'],
      ['⬜', 'Reopened at the close · $100.00'],
    ]);
    assert.equal(view.standing, 'Streak 1 weekend · 1/1 right overall · beat Base 1 time.');
    assert.match(decodeURIComponent(view.share!.x), /text=Call the reopen #1 🟩⬜ 1\/1 · Base 0\/1&url=https:\/\/miorail\.xyz\/stocks\/weekend$/);
  });
});
