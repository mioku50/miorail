import assert from 'node:assert/strict';
import test from 'node:test';

import { safeNextPathV1 } from './signInReturn';

test('a sign-in goes back to a path on this origin', () => {
  assert.equal(safeNextPathV1('/stocks/nvda?size=10000000000'), '/stocks/nvda?size=10000000000');
  assert.equal(safeNextPathV1('/market?key=security%3Aisin%3AUS67066G1040'), '/market?key=security%3Aisin%3AUS67066G1040');
});

test('and never to another origin, however the query string spells it', () => {
  for (const hostile of [
    '//evil.example/stocks',
    'https://evil.example/',
    '/\\evil.example',
    'javascript:alert(1)',
    'stocks/nvda',
    '',
    null,
    undefined,
  ]) {
    assert.equal(safeNextPathV1(hostile), '/stocks', `accepted ${String(hostile)}`);
  }
});
