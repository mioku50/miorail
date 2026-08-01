import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { changedTokensV1, shortAddressV1, type B20WatchedTokenLikeV1 } from '../src/console/B20WatchScreen';

// ---------------------------------------------------------------------------
// T67F — the B20 tab.
//
// The screen's whole job is to not overstate. Every test here is a way it could
// tell someone their tokens are fine when it does not know that.
// ---------------------------------------------------------------------------

const here = path.dirname(url.fileURLToPath(import.meta.url));

function token(overrides: Partial<B20WatchedTokenLikeV1> = {}): B20WatchedTokenLikeV1 {
  return {
    tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
    displayName: 'Token',
    displaySymbol: 'TKN',
    outcome: 'watched',
    reason: null,
    ...overrides,
  };
}

function watch(changes: { severity: 'acute' | 'material' | 'informational' }[]) {
  return {
    tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
    fromBlock: '100',
    toBlock: '200',
    changes: changes.map((change, index) => ({
      kind: 'field_changed',
      fieldKey: `field_${index}`,
      label: `Field ${index}`,
      severity: change.severity,
      before: 'a',
      after: 'b',
      detail: 'It changed.',
      evidenceBefore: null,
      evidenceAfter: null,
    })),
    gaps: [],
    status: 'compared' as const,
    notComparableReason: null,
  };
}

describe('ordering is over observed changes, never over tokens', () => {
  test('a token with an acute change sorts above one without', () => {
    const rows = changedTokensV1([
      token({ tokenAddress: '0xaaa', watch: watch([{ severity: 'informational' }]) }),
      token({ tokenAddress: '0xbbb', watch: watch([{ severity: 'acute' }]) }),
    ]);
    assert.deepEqual(rows.map((row) => row.tokenAddress), ['0xbbb', '0xaaa']);
  });

  test('a token with nothing to report is not in the changed list at all', () => {
    const rows = changedTokensV1([
      token({ tokenAddress: '0xaaa', watch: watch([]) }),
      token({ tokenAddress: '0xbbb', watch: watch([{ severity: 'material' }]) }),
    ]);
    assert.deepEqual(rows.map((row) => row.tokenAddress), ['0xbbb']);
  });

  test('an unreadable token never counts as changed or unchanged', () => {
    // It is neither. Putting it in either bucket is the lie this page exists
    // not to tell.
    const rows = changedTokensV1([
      token({ outcome: 'unreadable', reason: 'the endpoint did not answer', watch: undefined }),
    ]);
    assert.deepEqual(rows, []);
  });

  test('a first observation is not a change', () => {
    const rows = changedTokensV1([
      token({
        watch: {
          ...watch([]),
          status: 'first_observation',
          fromBlock: null,
        },
      }),
    ]);
    assert.deepEqual(rows, []);
  });
});

describe('the screen never says a token is safe', () => {
  const source = readFileSync(path.join(here, '../src/console/B20WatchScreen.tsx'), 'utf8');
  const visible = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  test('no verdict vocabulary reaches the screen', () => {
    for (const word of ['safe', 'risky', 'trusted', 'verified', 'score', 'rating', 'rug', 'legit']) {
      assert.ok(
        !new RegExp(`>[^<]*\\b${word}\\b`, 'i').test(visible),
        `the screen renders the word "${word}"`,
      );
    }
  });

  test('the unchanged group is called "No change", not anything reassuring', () => {
    assert.ok(visible.includes('<h3>No change</h3>'));
    assert.ok(!visible.includes('<h3>Safe</h3>'));
    assert.ok(!visible.includes('<h3>Clean</h3>'));
  });

  test('unreached tokens are named and distinguished from unchanged', () => {
    assert.ok(visible.includes('not the same as unchanged'));
  });

  test('the page states it cannot see who changed anything', () => {
    assert.ok(visible.includes('no way to list role holders'));
  });
});

describe('the sweep is explicit, not automatic', () => {
  const page = readFileSync(
    path.join(here, '../../../artifacts/interface/src/features/b20/B20WatchPage.tsx'),
    'utf8',
  );

  test('nothing sweeps on mount', () => {
    // Each run is up to 25 on-chain reads against a metered endpoint. A page
    // that spends an operator's RPC budget for being opened is a page nobody
    // should open.
    assert.ok(!/useEffect\([^)]*sweep\.mutate/s.test(page), 'the sweep runs on mount');
    assert.ok(page.includes('onSweep'), 'there is no way to ask for a sweep');
  });

  test('spam tokens are excluded before the budget is spent', () => {
    assert.ok(page.includes('possibleSpam'));
  });

  test('a disabled gate is not a statement about the tokens', () => {
    assert.ok(page.includes('This is not a statement about your tokens'));
  });
});

describe('the three tabs', () => {
  const routes = readFileSync(path.join(here, '../../../artifacts/interface/src/app/routes.tsx'), 'utf8');

  test('Routes, B20 and Proofs — and nothing else', () => {
    const labels = [...routes.matchAll(/label: '([^']+)' \}/g)].map((match) => match[1]);
    assert.deepEqual(labels.slice(0, 3), ['Routes', 'B20', 'Proofs']);
  });

  test('Budget & payments is not a tab', () => {
    // It is something you adjust in the middle of a flow, not a place you go.
    for (const banned of ['Budget', 'x402', 'Spend Permission', 'Payments']) {
      assert.ok(!routes.includes(`label: '${banned}'`), `"${banned}" became a tab`);
    }
  });

  test('both console surfaces can reach every tab', () => {
    for (const [surface, file] of [
      ['routes console', '../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx'],
      ['B20 page', '../../../artifacts/interface/src/features/b20/B20WatchPage.tsx'],
    ] as const) {
      const source = readFileSync(path.join(here, file), 'utf8');
      for (const target of ["'/'", "'/b20'", "'/plan/history'"]) {
        assert.ok(source.includes(`navigate(${target})`), `${surface} cannot reach ${target}`);
      }
    }
  });

  test('the active tab has a rule that actually applies to it', () => {
    // `.on` already existed for the theme toggle and the session list, and
    // neither rule reaches a .btn — so an active tab would have rendered
    // identically to an inactive one. consoleStyles.test.ts could not catch
    // this: it checks a class has a rule somewhere, not that it applies.
    const css = readFileSync(path.join(here, '../src/console/console.css'), 'utf8');
    assert.match(css, /\.crumb \.btn\.on\s*\{/);
  });
});

describe('addresses are shortened, never truncated into ambiguity', () => {
  test('a full address keeps both ends', () => {
    const short = shortAddressV1('0xb200000000000000000000d6f666fe8b27595c01');
    assert.ok(short.startsWith('0xb20000'));
    assert.ok(short.endsWith('5c01'));
  });

  test('something already short is left alone', () => {
    assert.equal(shortAddressV1('0xabc'), '0xabc');
  });
});
