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

describe('the B20 portfolio card', () => {
  test('a missing price is stated, never rendered as zero', async () => {
    // "$0.00" reaches a user as "worthless", which is a claim about the token.
    const { controlLinesV1 } = await import('../src/console/B20PortfolioPanel');
    const source = readFileSync(path.join(here, '../src/console/B20PortfolioPanel.tsx'), 'utf8');
    assert.ok(source.includes("usdLabel ?? 'no price source'"));
    assert.equal(typeof controlLinesV1, 'function');
  });

  test('an unread token shows no control lines rather than clean ones', async () => {
    const { controlLinesV1 } = await import('../src/console/B20PortfolioPanel');
    assert.deepEqual(controlLinesV1(null), []);
  });

  test('a transfer policy is reported as a gate, never as "you are blocked"', async () => {
    const { controlLinesV1 } = await import('../src/console/B20PortfolioPanel');
    const lines = controlLinesV1({
      factoryConfirmed: true,
      transfersPaused: false,
      transferPolicyActive: true,
      controlsFullyRead: true,
      supplyCapped: true,
      blockNumber: '49412880',
    });
    const policy = lines.find((line) => line.label === 'Transfer policy')!;
    // B20 offers no way to enumerate a policy, so the only honest statement is
    // that the gate exists.
    assert.match(policy.state, /specific addresses can be refused/);
    assert.ok(!/you are|your address is/i.test(policy.state));
    assert.equal(policy.alarming, true);
  });

  test('an uncapped supply is alarming and a capped one is not', async () => {
    const { controlLinesV1 } = await import('../src/console/B20PortfolioPanel');
    const base = {
      factoryConfirmed: true,
      transfersPaused: false,
      transferPolicyActive: false,
      controlsFullyRead: true,
      blockNumber: '1',
    };
    assert.equal(controlLinesV1({ ...base, supplyCapped: false }).find((l) => l.label === 'Supply')!.alarming, true);
    assert.equal(controlLinesV1({ ...base, supplyCapped: true }).find((l) => l.label === 'Supply')!.alarming, false);
  });

  test('a paused token says it cannot be sold', async () => {
    const { controlLinesV1 } = await import('../src/console/B20PortfolioPanel');
    const lines = controlLinesV1({
      factoryConfirmed: true,
      transfersPaused: true,
      transferPolicyActive: false,
      controlsFullyRead: true,
      supplyCapped: true,
      blockNumber: '1',
    });
    assert.match(lines[0]!.state, /cannot be sold/);
  });

  test('an incomplete read is never presented as a complete one', async () => {
    const { controlLinesV1 } = await import('../src/console/B20PortfolioPanel');
    const lines = controlLinesV1({
      factoryConfirmed: true,
      transfersPaused: false,
      transferPolicyActive: false,
      controlsFullyRead: false,
      supplyCapped: true,
      blockNumber: '1',
    });
    const read = lines.find((line) => line.label === 'Read')!;
    assert.match(read.state, /incomplete/);
    assert.equal(read.alarming, true);
  });

  test('the card carries no score, badge or grade', () => {
    const source = readFileSync(path.join(here, '../src/console/B20PortfolioPanel.tsx'), 'utf8');
    const visible = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const word of ['/100', 'score', 'rating', 'grade', 'safe', 'risk level']) {
      assert.ok(!visible.toLowerCase().includes(word.toLowerCase()), `the card mentions "${word}"`);
    }
  });

  test('swapping a held token hands over to the Routes flow', () => {
    // Not a second execution path. The tab passes the goal along.
    const page = readFileSync(
      path.join(here, '../../../artifacts/interface/src/features/b20/B20WatchPage.tsx'),
      'utf8',
    );
    assert.ok(page.includes("navigate(`/?goal="));
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
