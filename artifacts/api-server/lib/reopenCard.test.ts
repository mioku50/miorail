import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { ReopenSharedResultV1 } from '@mioagent/rwa-market-reality/reopen-game-service';

import { renderCardPngV1 } from './cardImage.js';
import { reopenCardSvgV1, reopenCardV1 } from './reopenCard.js';

const stock = (
  symbol: string,
  pick: 'up' | 'down' | null,
  baseCall: 'up' | 'down' | null,
  reopen: string | null,
  outcome: 'up' | 'down' | 'void',
): ReopenSharedResultV1['stocks'][number] => ({ symbol, name: `${symbol} Inc.`, close: '100.00', pick, baseCall, reopen, outcome });

// The weekend of 2026-10-09: a Friday close, the reopen on Sunday.
const SHARED_RESULT_V1: ReopenSharedResultV1 = {
  roundId: '2026-10-09',
  number: 2,
  closeAt: '2026-10-09T20:00:00.000Z',
  opensAt: '2026-10-10T00:00:00.000Z',
  expectedReopenAt: '2026-10-12T00:00:00.000Z',
  stocks: [
    stock('NVDA', 'up', 'up', '102.00', 'up'),
    stock('TSLA', 'down', 'down', '101.00', 'up'),
    stock('AAPL', 'down', 'up', '99.00', 'down'),
    stock('AMZN', null, 'down', '100.00', 'void'),
    stock('MSTR', 'up', null, null, 'void'),
  ],
  mine: { correct: 2, of: 3, cells: '🟩🟥🟩⬜⬜' },
  base: { correct: 1, of: 3, cells: '🟩🟥🟥⬜⬜' },
};

describe('the picture under a shared Call the reopen result', () => {
  test('the score, Base beside it, and every call with how it reopened', () => {
    const card = reopenCardV1(SHARED_RESULT_V1);
    assert.equal(card.kicker, 'Call the reopen #2 · Fri Oct 9 close');
    assert.equal(card.title, '2 of 3 right');
    assert.equal(card.lede, 'Beat Base, which called 1 of 3 from its own price on Base at the lock.');
    assert.deepEqual(card.columns, ['Stock', 'Called', 'Base', 'Reopened vs Friday']);
    assert.deepEqual(
      card.rows.map((row) => [row.symbol, row.pick, row.baseCall, row.reopen, row.mark]),
      [
        ['NVDA', 'up', 'up', '$102.00', 'right'],
        ['TSLA', 'down', 'down', '$101.00', 'wrong'],
        ['AAPL', 'down', 'up', '$99.00', 'right'],
        ['AMZN', null, 'down', '$100.00', 'none'],
        ['MSTR', 'up', null, null, 'none'],
      ],
    );
    assert.equal(card.pageTitle, 'Call the reopen #2: 2/3, Base 1/3 · Miorail');
    assert.match(card.alt, /NVDA called up, reopened up; TSLA called down, reopened up; AAPL called down, reopened down; AMZN no call, reopened at the close; MSTR called up, no reopen print\. 2 of 3 right; Base 1 of 3\.$/);
    assert.match(card.description, /will five stocks reopen above or below Friday's close\?/);
    // Level and behind read from the poster's side too.
    assert.match(reopenCardV1({ ...SHARED_RESULT_V1, base: { ...SHARED_RESULT_V1.base, correct: 2 } }).lede, /^Level with Base/);
    assert.match(reopenCardV1({ ...SHARED_RESULT_V1, base: { ...SHARED_RESULT_V1.base, correct: 3 } }).lede, /^Base called 3 of 3/);
  });

  test('before a holiday Friday the column names Thursday', () => {
    const card = reopenCardV1({ ...SHARED_RESULT_V1, closeAt: '2026-12-24T18:00:00.000Z', opensAt: '2026-12-25T01:00:00.000Z' });
    assert.equal(card.columns[3], 'Reopened vs Thursday');
    assert.equal(card.kicker, 'Call the reopen #2 · Thu Dec 24 close');
  });

  test('it names nobody, colours only right and wrong, and becomes a 1200 by 630 PNG', async () => {
    const svg = reopenCardSvgV1(reopenCardV1(SHARED_RESULT_V1));
    assert.doesNotMatch(svg, /0x[0-9a-f]{6}|Player \d|\.base\.eth/i, 'the picture says how a call went, not who made it');
    // Two squares right, one wrong, two that count for nobody.
    assert.equal(svg.match(/fill="#2ea043"/g)?.length, 2);
    assert.equal(svg.match(/fill="#da3633"/g)?.length, 1);
    assert.equal(svg.match(/rx="6" fill="#2c2f45"/g)?.length, 2);
    const png = Buffer.from(await renderCardPngV1(svg));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  });
});
