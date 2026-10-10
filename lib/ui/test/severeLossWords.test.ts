import assert from 'node:assert/strict';
import test from 'node:test';

import { exitCostViewV1, severeLossWordsV1 } from '../src/console/marketRealityView';

test('a severe round trip is worded by what it lost, not by the band it is in', () => {
  // PFEc, 2026-10-10: $1,000 in, $793.10 back. "Most of the money is not" was
  // printed beside it.
  assert.equal(severeLossWordsV1(2_068), 'a fifth or more of the money does not come back');
  assert.equal(severeLossWordsV1(4_999), 'a fifth or more of the money does not come back');
  // CAKEc: $1,000 in, $119.88 back.
  assert.equal(severeLossWordsV1(8_801), 'most of the money does not come back');
  const pfe = exitCostViewV1({ roundTripCostBps: '2068' } as never)!;
  assert.match(pfe.note, /a fifth or more of the money does not come back$/);
  assert.doesNotMatch(pfe.note, /most of the money/);
});
