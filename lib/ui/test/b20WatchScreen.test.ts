import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { exitMeasureLabelV1, simulateLabelV1 } from '../src/console/B20ExitCard';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  EXIT_PROFILE_DEFAULTS_V1,
  clearanceExpiredV1,
  entryPlanAvailableV1,
  exitHeadlineV1,
  percentToBpsV1,
  unitPriceFromBuyQuoteV1,
  usdcToAtomicV1,
} from '../src/console/B20ExitCard';
import {
  changedTokensV1,
  shortAddressV1,
  trackedOutcomeLabelV1,
  trackedReadAtLabelV1,
  trackedReadLabelV1,
  trackedReadAgeV1,
  trackedStatusLineV1,
  trackedTokenSymbolV1,
  type B20WatchedTokenLikeV1,
} from '../src/console/B20WatchScreen';

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
    assert.ok(source.includes("usdLabel ?? 'not priced · measure below'"));
    assert.equal(typeof controlLinesV1, 'function');
  });

  test('a buy quote becomes a unit price without floating point', () => {
    assert.equal(
      unitPriceFromBuyQuoteV1({
        inputAtomic: '100000000',
        outputAtomic: '20000000000000000000000',
        tokenDecimals: 18,
      }),
      '$0.005',
    );
    assert.equal(unitPriceFromBuyQuoteV1({ inputAtomic: null, outputAtomic: '1', tokenDecimals: 18 }), null);
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
    //
    // This used to assert `navigate(\`/?goal=` — the literal shape of the bug.
    // `/` is a redirect route that dropped the query string, so the assertion
    // was pinning a button that landed the user on Discover with nothing. What
    // matters is the destination and the one-shot token, not the string.
    const page = readFileSync(
      path.join(here, '../../../artifacts/interface/src/features/b20/B20WatchPage.tsx'),
      'utf8',
    );
    assert.ok(page.includes('swapTokenHrefV1('), 'the href has one spelling, shared with the console');
    assert.ok(!page.includes('navigate(`/?goal='), 'never `/`: that route drops the query');
    assert.ok(
      page.includes('GOAL_HANDOFF_KEY_V1'),
      'a click leaves the token that separates it from a link someone sent',
    );
  });
});

describe('a B20 token can be tracked by hand', () => {
  const screen = readFileSync(path.join(here, '../src/console/B20WatchScreen.tsx'), 'utf8');
  const page = readFileSync(
    path.join(here, '../../../artifacts/interface/src/features/b20/B20WatchPage.tsx'),
    'utf8',
  );

  test('the page explains why the portfolio alone cannot find B20 tokens', () => {
    // Observed: a wallet holding $MIO (a real B20 at 0xB2000000000000000000
    // 00578F3Ae29d9e6e0101) had it reported by no balance provider, so the
    // sweep never received the address.
    assert.match(screen, /Balance providers do not index B20/);
    assert.match(screen, /reported as holding nothing/);
  });

  test('a tracked address must be a real address', () => {
    assert.match(screen, /\^0x\[0-9a-fA-F\]\{40\}\$/);
  });

  test('tracked addresses take the sweep budget before provider-reported ones', () => {
    // They were added deliberately; a provider balance was not. If the cap has
    // to bite, it must bite the list the user did not curate.
    assert.match(page, /\[\.\.\.tracked, \.\.\.held/);
  });

  test('a corrupt stored list does not take the page down', () => {
    assert.match(page, /catch \{/);
    assert.match(page, /TRACKED_KEY_V1/);
  });

  test('the watchlist lives on the server, because a timer has no browser to ask', () => {
    // T68B. A list in localStorage is a list nothing can watch.
    assert.match(page, /useB20Watchlist/);
    assert.match(page, /list in localStorage is a\s*\n?\s*\/\/ list nothing can watch/);
  });

  test('what the browser already tracked is pushed up, not dropped', () => {
    // Deleting a list a user built by hand is the one thing a storage change
    // must not do.
    assert.match(page, /seeded/);
    assert.match(page, /addWatch\.mutate\(\{ tokenAddress: token \}\)/);
  });

  test('the page claims background watching, and each row makes the claim checkable', () => {
    assert.match(screen, /Miorail reads these on its own/);
    assert.match(screen, /Opening this page is not what\s*\n?\s*makes that happen/);
    // The ROW renders the timestamp. `trackedStatusLineV1` is still exported
    // for one-line contexts, so matching its name would pass on the definition
    // alone — the row has to be the thing asserted.
    assert.match(screen, /trackedReadAtLabelV1\(entry\)/);
    assert.match(screen, /trackedReadLabelV1\(entry\)/);
  });

  test('never read is not the same sentence as nothing changed', () => {
    assert.match(screen, /return 'not read yet'/);
  });

  test('a full watchlist is its own message, not the sweep\u2019s banner', () => {
    // A full list and an unreadable chain are different problems, and only one
    // of them is fixed by pressing Read B20 controls again.
    assert.match(page, /b20_watchlist_full/);
    assert.match(page, /trackError/);
  });

  test('the balance comes from the token, not from the balance provider', () => {
    assert.match(page, /formatBalanceV1\(token\.balanceAtomic/);
    // "not read" — never a zero, which would repeat the provider's own error
    // with Miorail's name on it.
    assert.match(page, /return 'not read'/);
  });

  test('balance formatting is integer arithmetic', () => {
    // A float turns 18 decimals into scientific notation.
    assert.match(page, /BigInt\(atomic\)/);
    assert.ok(!/Number\(atomic\)/.test(page));
  });
});

describe('a watched token says when Miorail last looked', () => {
  test('never read says so, rather than borrowing the blank a steady token uses', () => {
    assert.equal(
      trackedStatusLineV1({ tokenAddress: '0xabc', lastSweptAt: null, lastOutcome: null }),
      'not read yet',
    );
  });

  test('a failed reading is not a reading', () => {
    const line = trackedStatusLineV1({
      tokenAddress: '0xabc',
      lastSweptAt: '2026-08-02T09:30:00.000Z',
      lastOutcome: 'unreadable',
    });
    assert.match(line, /could not be read/);
    // "tried", not "read": nothing was learned about the token.
    assert.match(line, /tried 2026-08-02 09:30/);
  });

  test('not a B20 token is an ordinary answer, and dated', () => {
    const line = trackedStatusLineV1({
      tokenAddress: '0xabc',
      lastSweptAt: '2026-08-02T09:30:00.000Z',
      lastOutcome: 'not_b20',
    });
    assert.match(line, /not a B20 token/);
    assert.ok(!/could not|fail/i.test(line));
  });

  test('a successful reading carries its date, so freshness is never implied', () => {
    assert.equal(
      trackedStatusLineV1({
        tokenAddress: '0xabc',
        lastSweptAt: '2026-08-02T09:30:00.000Z',
        lastOutcome: 'read',
      }),
      'read 2026-08-02 09:30 UTC',
    );
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

describe('the four sections', () => {
  const routes = readFileSync(path.join(here, '../../../artifacts/interface/src/app/routes.tsx'), 'utf8');

  test('the web tab table is derived, not typed out', () => {
    // T70 §8 — the words live in ONE place. A literal `label:` string in this
    // file is a second vocabulary, which is how the two surfaces drifted apart
    // before this task.
    assert.ok(!/label:\s*'/.test(routes), 'routes.tsx must not carry its own labels');
    assert.ok(routes.includes('CONSOLE_SECTION_TABLE_V1'), 'routes.tsx must read the shared table');
  });

  test('Budget & payments is not a tab', () => {
    // It is something you adjust occasionally, not a place you go. It lives on
    // Settings, which the header does not carry.
    for (const banned of ['Budget', 'x402', 'Spend Permission', 'Payments']) {
      assert.ok(!routes.includes(`label: '${banned}'`), `"${banned}" became a tab`);
    }
  });

  test('every console surface navigates through the shared hook', () => {
    // Not through hand-written paths: a page that calls navigate('/b20')
    // directly is a page that will keep working after the section is renamed
    // and quietly stop highlighting the right tab.
    for (const [surface, file] of [
      ['routes console', '../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx'],
      ['portfolio page', '../../../artifacts/interface/src/features/b20/B20WatchPage.tsx'],
      ['opportunities page', '../../../artifacts/interface/src/features/opportunities/OpportunitiesPage.tsx'],
      ['settings page', '../../../artifacts/interface/src/features/settings/SettingsPage.tsx'],
    ] as const) {
      const source = readFileSync(path.join(here, file), 'utf8');
      assert.ok(
        source.includes('useConsoleNav') || source.includes('consoleSectionPathV1'),
        `${surface} builds navigation of its own`,
      );
      assert.ok(!/navigate\('\/b20'\)/.test(source), `${surface} still hard-codes the old B20 path`);
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

describe('T68D — an optimistic quote never opens the entry route', () => {
  const card = readFileSync(path.join(here, '../src/console/B20ExitCard.tsx'), 'utf8');
  const page = readFileSync(
    path.join(here, '../../../artifacts/interface/src/features/b20/B20WatchPage.tsx'),
    'utf8',
  );
  const base = {
    reason: null,
    measurement: null,
    optimistic: false,
    roundTripCostBps: 120,
    exitCapacityAtomic: null,
    firstFailingAtomic: null,
    probeCount: 0,
    capacityInformative: false,
    referenceSizeAtomic: null,
    endpointDegraded: false,
    controlsBlockNumber: '49450000',
    checkedAt: '2026-08-03T12:00:00.000Z',
  } as const;
  const profile = { positionLabel: '100 USDC', slippagePercentLabel: '3%' };

  test('provisional says the exit was quoted before the entry moved the pool', () => {
    const line = exitHeadlineV1({ ...base, status: 'provisional' }, profile);
    assert.match(line, /Provisional exit/);
    assert.match(line, /before the entry moved the pool/);
    assert.match(line, /Nothing has been simulated yet/);
  });

  test('a provisional result has no Build entry plan control at all', () => {
    // Not disabled — absent. A button that exists and is greyed out is one
    // refactor away from being enabled by accident.
    assert.match(card, /\{entryAvailable && \(/);
    assert.match(card, /check\.status === 'provisional' && \(/);
    assert.match(card, /Run full simulation/);
  });

  test('the entry control needs a clearance id, not merely a pass', () => {
    // T68E moved the five conditions into one gate. The click still cannot
    // happen without a clearance id.
    assert.match(card, /onBuildEntryPlan\?\.\(check\.clearanceId!\)/);
    assert.match(card, /if \(!check\.clearanceId\) return false;/);
  });

  test('qualified shows the simulation block and the clearance expiry', () => {
    assert.match(card, /Simulated round trip/);
    assert.match(card, /Simulated at/);
    assert.match(card, /Clearance expires/);
  });

  test('viable-but-not-best is never collapsed into either extreme', () => {
    const line = exitHeadlineV1(
      { ...base, status: 'qualified', viableRouteConfirmed: true, bestRouteConfirmed: false },
      profile,
    );
    assert.match(line, /Viable route confirmed/);
    assert.match(line, /best route not confirmed/);
  });

  test('an unmeasured reason names the dependency that did not answer', () => {
    const line = exitHeadlineV1(
      { ...base, status: 'unmeasured', unmeasuredReason: 'insufficient_probe_balance' },
      profile,
    );
    // A wallet's balance is not a property of the token, and the copy says so.
    assert.match(line, /does not hold enough USDC/);
    assert.match(line, /about the wallet, not the token/);
  });

  test('no state may say safe, score, rating or guaranteed', () => {
    const states = ['rejected', 'provisional', 'qualified', 'unmeasured'] as const;
    for (const status of states) {
      const line = exitHeadlineV1({ ...base, status, reason: 'transfers_paused' }, profile);
      assert.ok(!/\b(safe|score|rating|promising|guaranteed)\b/i.test(line), line);
    }
  });

  test('the profile is the user’s, and the defaults live in the UI', () => {
    assert.deepEqual(EXIT_PROFILE_DEFAULTS_V1, { position: '100', maxRoundTrip: '3', maxSlippage: '3' });
    assert.match(page, /EXIT_PROFILE_DEFAULTS_V1/);
    assert.match(card, /Position \(USDC\)/);
    assert.match(card, /Max round trip/);
    assert.match(card, /Max exit slippage/);
  });

  test('money never goes through a float', () => {
    assert.equal(usdcToAtomicV1('100'), '100000000');
    assert.equal(usdcToAtomicV1('1'), '1000000');
    // A fractional position is refused rather than silently truncated.
    assert.equal(usdcToAtomicV1('1.5'), null);
    assert.equal(usdcToAtomicV1('0'), null);
    assert.equal(usdcToAtomicV1(''), null);
    assert.equal(percentToBpsV1('3'), 300);
    assert.equal(percentToBpsV1('3.5'), 350);
    assert.equal(percentToBpsV1('0'), null);
    assert.equal(percentToBpsV1('abc'), null);
  });

  test('the page offers an entry plan only through the clearance gate', () => {
    // T68F-B wired the handoff. The invariant did not change: the control still
    // cannot appear without a live, qualified clearance — that gate simply
    // moved from "pass no handler" to `entryPlanAvailableV1` inside the card,
    // which is checked by its own tests below.
    assert.match(page, /onBuildEntryPlan: buildEntryPlan/);
    // And the handler refuses to do anything without a clearance id.
    assert.match(page, /if \(!clearanceId\) return;/);
  });
});

describe('T68E — the entry control exists only when everything is true', () => {
  const card = readFileSync(path.join(here, '../src/console/B20ExitCard.tsx'), 'utf8');
  const NOW = new Date('2026-08-03T12:00:00.000Z');
  const qualified = {
    status: 'qualified' as const,
    reason: null,
    measurement: null,
    optimistic: false,
    roundTripCostBps: 120,
    exitCapacityAtomic: null,
    firstFailingAtomic: null,
    probeCount: 0,
    capacityInformative: false,
    referenceSizeAtomic: null,
    endpointDegraded: false,
    controlsBlockNumber: '49450000',
    checkedAt: NOW.toISOString(),
    clearanceId: 'clearance-1',
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
  };

  test('qualified with a live clearance and a wired handler shows it', () => {
    assert.equal(entryPlanAvailableV1({ check: qualified, now: NOW, handlerWired: true }), true);
  });

  test('a provisional result never shows it', () => {
    assert.equal(
      entryPlanAvailableV1({
        check: { ...qualified, status: 'provisional' },
        now: NOW,
        handlerWired: true,
      }),
      false,
    );
  });

  test('no wired handler shows no control at all, not a dead one', () => {
    // A greyed-out button is one refactor from being enabled by accident, and
    // this is the button that spends money.
    assert.equal(entryPlanAvailableV1({ check: qualified, now: NOW, handlerWired: false }), false);
  });

  test('a qualified result with no clearance shows nothing', () => {
    assert.equal(
      entryPlanAvailableV1({ check: { ...qualified, clearanceId: null }, now: NOW, handlerWired: true }),
      false,
    );
  });

  test('an expired clearance shows no entry control, and says re-run', () => {
    const later = new Date(NOW.getTime() + 900_000);
    assert.equal(entryPlanAvailableV1({ check: qualified, now: later, handlerWired: true }), false);
    // Earned then went stale — a different instruction from "not qualified".
    assert.equal(clearanceExpiredV1({ check: qualified, now: later }), true);
    assert.match(card, /Qualification expired — run again/);
  });

  test('a provisional result is never "expired"', () => {
    assert.equal(
      clearanceExpiredV1({ check: { ...qualified, status: 'provisional' }, now: NOW }),
      false,
    );
  });

  test('the card consults the gate rather than inlining the conditions', () => {
    assert.match(card, /entryPlanAvailableV1/);
    assert.match(card, /\{entryAvailable && \(/);
  });
});

describe('the price is on the control, not in a footnote', () => {
  test('a priced simulation states what it costs before it is pressed', () => {
    assert.equal(simulateLabelV1('0.0002', false), 'Run full simulation · $0.0002');
  });

  test('a free simulation claims no price', () => {
    // Null and "0" are different. A card printing "$0" would be asserting a
    // price where the server has none.
    assert.equal(simulateLabelV1(null, false), 'Run full simulation');
    assert.equal(simulateLabelV1(undefined, false), 'Run full simulation');
    assert.equal(simulateLabelV1('  ', false), 'Run full simulation');
  });

  test('a running simulation shows progress, not a price to press again', () => {
    assert.equal(simulateLabelV1('0.0002', true), 'Simulating both legs…');
  });
});

// ---------------------------------------------------------------------------
// A watched token is a ROW, not a run-together string.
//
// Observed in production: `0xb20000…0101read 2026-08-15 20:33 UTC Remove`. The
// three children sat in a two-column `.kv` grid, so the address, the timestamp
// and the button had nothing between them. The facts were all correct and none
// of them was legible.
// ---------------------------------------------------------------------------
describe('a watched token row keeps its parts apart', () => {
  const entry = (over: Partial<{ lastSweptAt: string | null; lastOutcome: 'read' | 'not_b20' | 'unreadable' | null }> = {}) => ({
    tokenAddress: '0xb2000000000000000000000578f3ae29d9e6e0101',
    lastSweptAt: '2026-08-15T20:33:12.000Z' as string | null,
    lastOutcome: 'read' as 'read' | 'not_b20' | 'unreadable' | null,
    ...over,
  });

  test('the timestamp is a value, not a sentence glued to an address', () => {
    assert.equal(trackedReadAtLabelV1(entry()), 'Aug 15 · 20:33 UTC');
    assert.equal(trackedReadLabelV1(entry()), 'Last read');
  });

  test('a failed reading is not a reading, and the label says so', () => {
    // The distinction `trackedStatusLineV1` carried in the word "tried" now
    // lives in the label, so the row can put the two on separate lines.
    assert.equal(trackedReadLabelV1(entry({ lastOutcome: 'unreadable' })), 'Last tried');
    assert.equal(trackedOutcomeLabelV1(entry({ lastOutcome: 'unreadable' })), 'could not be read');
  });

  test('not a B20 token is an ordinary answer and keeps its date', () => {
    assert.equal(trackedOutcomeLabelV1(entry({ lastOutcome: 'not_b20' })), 'not a B20 token');
    assert.equal(trackedReadAtLabelV1(entry({ lastOutcome: 'not_b20' })), 'Aug 15 · 20:33 UTC');
  });

  test('an ordinary reading carries no outcome line, so the row stays two deep', () => {
    assert.equal(trackedOutcomeLabelV1(entry()), null);
  });

  test('never read says so rather than borrowing a blank', () => {
    assert.equal(trackedReadAtLabelV1(entry({ lastSweptAt: null, lastOutcome: null })), 'not read yet');
    assert.equal(trackedOutcomeLabelV1(entry({ lastSweptAt: null, lastOutcome: null })), null);
  });

  test('the stamp is read as UTC, never through a browser timezone', () => {
    // A date near midnight is where a local-time render would show a different
    // day, and the value stored is UTC.
    assert.equal(
      trackedReadAtLabelV1({ tokenAddress: '0xa', lastSweptAt: '2026-01-01T23:50:00.000Z', lastOutcome: 'read' }),
      'Jan 1 · 23:50 UTC',
    );
  });

  test('an unparseable stamp is shown verbatim rather than guessed at', () => {
    assert.equal(
      trackedReadAtLabelV1({ tokenAddress: '0xa', lastSweptAt: 'whenever', lastOutcome: 'read' }),
      'whenever',
    );
  });
});

describe('a watched token is named from data already on the screen', () => {
  const source = {
    tokens: [
      { tokenAddress: '0xB2000000000000000000000578F3AE29D9E6E0101', displaySymbol: 'MIO', displayName: 'Mio' },
      { tokenAddress: '0xb200000000000000000000000000000000000002', displaySymbol: null, displayName: 'Second' },
    ],
    holdings: [{ tokenAddress: '0xb200000000000000000000000000000000000003', symbol: 'HELD' }],
  };

  test('the control watch names it, whatever case the address arrived in', () => {
    assert.equal(trackedTokenSymbolV1('0xb2000000000000000000000578f3ae29d9e6e0101', source), 'MIO');
  });

  test('a name is used when there is no symbol', () => {
    assert.equal(trackedTokenSymbolV1('0xb200000000000000000000000000000000000002', source), 'Second');
  });

  test('the portfolio is the next fallback, and an unknown address stays an address', () => {
    assert.equal(trackedTokenSymbolV1('0xb200000000000000000000000000000000000003', source), 'HELD');
    // The row then renders the address the user pasted. Inventing a name for an
    // address nothing has read would be worse than showing the address.
    assert.equal(trackedTokenSymbolV1('0xb2000000000000000000000000000000000000ff', source), null);
  });

  // -------------------------------------------------------------------------
  // The wallet balances, which are the source that actually has the name.
  //
  // The two above are both EMPTY until a sweep runs. The balances card at the
  // top of the same page is populated on load — so a wallet showing
  // "MIO 19210.9481" still had a bare `0xb200…0101` in its watchlist below.
  // -------------------------------------------------------------------------
  const beforeAnySweep = {
    tokens: [] as typeof source.tokens,
    holdings: [] as typeof source.holdings,
    walletTokens: [
      { address: '0xB2000000000000000000000578F3AE29D9E6E0101', symbol: 'MIO', name: 'Mio' },
      { address: 'native', symbol: 'ETH' },
      { address: '0xb200000000000000000000000000000000000004', symbol: null, name: 'Fourth' },
    ],
  };

  test('a balance the page already shows names the watched address', () => {
    assert.equal(trackedTokenSymbolV1('0xb2000000000000000000000578f3ae29d9e6e0101', beforeAnySweep), 'MIO');
  });

  test('a balance with only a name still beats showing an address', () => {
    assert.equal(trackedTokenSymbolV1('0xb200000000000000000000000000000000000004', beforeAnySweep), 'Fourth');
  });

  test('an address no source has seen keeps the address, balances or not', () => {
    assert.equal(trackedTokenSymbolV1('0xb2000000000000000000000000000000000000ff', beforeAnySweep), null);
    // `native` has no contract address to match, and must never be mistaken for
    // one — an address-keyed lookup against it would be a silent wrong name.
    assert.equal(trackedTokenSymbolV1('native', beforeAnySweep), null);
  });

  test('the sources are ordered by how much this page knows', () => {
    // The control watch read the token itself; a provider only reported a
    // ticker. When both have an opinion the token's own name wins.
    const both = {
      tokens: [{ tokenAddress: '0xb200000000000000000000000000000000000005', displaySymbol: 'FROMCHAIN', displayName: null }],
      holdings: [{ tokenAddress: '0xb200000000000000000000000000000000000005', symbol: 'FROMSWEEP' }],
      walletTokens: [{ address: '0xb200000000000000000000000000000000000005', symbol: 'FROMPROVIDER' }],
    };
    assert.equal(trackedTokenSymbolV1('0xb200000000000000000000000000000000000005', both), 'FROMCHAIN');
  });

  test('a host that wires no balances behaves exactly as before', () => {
    assert.equal(trackedTokenSymbolV1('0xb2000000000000000000000578f3ae29d9e6e0101', source), 'MIO');
    assert.equal(trackedTokenSymbolV1('0xb2000000000000000000000000000000000000ff', source), null);
  });
});

// ---------------------------------------------------------------------------
// The screen names the button that is actually on it.
//
// The empty state said "press Check now"; the control is called "Read B20
// controls", and has been for long enough that the sentence was sending people
// looking for a button that is not on the page.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Portfolio reads the token Discover hands it.
//
// Discover has pointed `/portfolio?token=0x…` at this page for as long as the
// feed has had actions, and this page never read the parameter — so every one
// of those clicks arrived at a generic Portfolio with the selection dropped.
// ---------------------------------------------------------------------------
describe('the token Discover hands over is consumed', () => {
  const page = readFileSync(
    path.join(here, '../../../artifacts/interface/src/features/b20/B20WatchPage.tsx'),
    'utf8',
  );
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  test('it is read through the same validated parser Discover writes it with', () => {
    // Not a hand-rolled `searchParams.get('token')`: a query parameter is text
    // a stranger can choose, and two spellings of one parameter is how it came
    // to be written by one surface and read by none.
    assert.ok(code.includes('parseDiscoverFocusV1('), 'the page does not use the shared parser');
    assert.ok(code.includes('useSearch()'), 'the page does not react to the query string');
  });

  test('it selects the exit subject and takes the reader to it', () => {
    assert.ok(code.includes('setExitToken(handedOverToken)'), 'the handed-over token selects nothing');
    assert.ok(code.includes('revealAnchor(B20_EXIT_ANCHOR_V1)'), 'the reader is not taken to the card');
  });

  test('a URL never spends the router budget', () => {
    // One exit check is a dozen-odd metered router calls. A link is not a
    // press, and a page that measured on arrival would let anybody spend an
    // operator's endpoint by sending a URL.
    const handoff = /consumedToken\.current = handedOverToken;[\s\S]{0,400}?\}, \[handedOverToken/.exec(code);
    assert.ok(handoff, 'the handoff effect could not be found — this test has gone stale');
    assert.ok(!/runExitCheck\(|exitCheck\.mutate\(/.test(handoff[0]), 'a URL started a metered check');
  });

  test('no surface builds a token link by hand any more', () => {
    const opportunities = readFileSync(
      path.join(here, '../../../artifacts/interface/src/features/opportunities/OpportunitiesPage.tsx'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\?token=\$\{/.test(opportunities), 'a hand-spelled ?token= link came back');
    assert.ok(opportunities.includes('discoverFocusHrefV1('), 'the links are not built by the shared builder');
  });
});

describe('the exit card offers to measure before it offers to re-measure', () => {
  test('a selected but unmeasured token is offered a first measurement', () => {
    // The state a deep link arrives in. "Re-measure" here offers to redo
    // something that has not happened.
    assert.equal(
      exitMeasureLabelV1({ tokenLabel: 'MIO', checked: false, loading: false }),
      'Measure price & exit',
    );
  });

  test('once measured it offers to do it again', () => {
    assert.equal(exitMeasureLabelV1({ tokenLabel: 'MIO', checked: true, loading: false }), 'Re-measure');
  });

  test('no token still says which control to use first', () => {
    assert.equal(
      exitMeasureLabelV1({ tokenLabel: null, checked: false, loading: false }),
      'Select a B20 token above',
    );
  });

  test('in flight it says what it is doing, whatever the other two are', () => {
    for (const checked of [false, true]) {
      assert.equal(
        exitMeasureLabelV1({ tokenLabel: 'MIO', checked, loading: true }),
        'Quoting supported venues…',
      );
    }
  });
});

describe('the copy names the control it is talking about', () => {
  const screenSource = readFileSync(path.join(here, '..', 'src', 'console', 'B20WatchScreen.tsx'), 'utf8');
  const panelSource = readFileSync(path.join(here, '..', 'src', 'console', 'B20PortfolioPanel.tsx'), 'utf8');

  test('the empty state points at "Read B20 controls"', () => {
    assert.match(screenSource, /press Read B20 controls to read this wallet’s tokens/);
  });

  test('no rendered string on either surface says "Check now"', () => {
    for (const [name, source] of [['B20WatchScreen', screenSource], ['B20PortfolioPanel', panelSource]] as const) {
      // Comments legitimately discuss the old name; rendered strings must not.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      assert.ok(!/Check now/.test(code), `${name} still renders "Check now"`);
    }
  });

  test('both surfaces spell the button the same way', () => {
    assert.match(screenSource, /'Read B20 controls'/);
    assert.match(panelSource, /'Read B20 controls'/);
  });
});

// ---------------------------------------------------------------------------
// P2 — the exit form, and the two emptinesses that read as one.
// ---------------------------------------------------------------------------
describe('the exit form is sized for what it holds', () => {
  const card = readFileSync(path.join(here, '../src/console/B20ExitCard.tsx'), 'utf8');
  const css = readFileSync(path.join(here, '../src/console/console.css'), 'utf8');

  test('a three-character number does not use the write-a-sentence box', () => {
    // `.goalinput` is 16px type with 14px padding and `width:100%`, so
    // "100", "3" and "3" each stood ~50px tall and pushed their own labels
    // onto a second line.
    assert.ok(!/className="goalinput"/.test(card), 'the exit form is back on the goal input');
    assert.equal((card.match(/className="numinput"/g) ?? []).length, 3);
    assert.match(css, /\.mio-console \.numinput \{/);
    // Digits in a column line up.
    assert.match(css, /\.numinput[^}]*tabular-nums/);
  });

  test('the wallet and the token have different emptinesses, and say so', () => {
    // Both panels used to print "Nothing has been checked yet." — one about a
    // wallet nobody swept, one about a token nobody measured. Identical words
    // for two different absences read as the same absence twice.
    assert.ok(!/Nothing has been checked yet\./.test(card));
    assert.match(card, /No token selected, so there is no exit to measure yet/);
    assert.match(card, /No exit measured for \$\{tokenLabel\} yet/);
  });
});


// ---------------------------------------------------------------------------
// A control reading has an age, and the age is the point.
//
// The row said `Last read  Aug 15 · 20:33 UTC` while the panel below it said
// "No control changed". Both true, and together they read as a statement about
// now — unless the reader knows today's date and does the subtraction. A week
// old is a different fact from an hour old, and the row has to say which.
// ---------------------------------------------------------------------------
describe('a tracked token states how old its reading is', () => {
  const at = (iso: string) => ({ tokenAddress: '0xb20', lastSweptAt: iso, lastOutcome: 'read' as const });

  test('a week-old reading leads with its age and is marked stale', () => {
    const age = trackedReadAgeV1(at('2026-08-15T20:33:00.000Z'), new Date('2026-08-22T20:33:00.000Z'));
    assert.equal(age.label, '7d ago');
    assert.equal(age.stale, true);
  });

  test('a reading inside the day is fresh and says so in hours', () => {
    const age = trackedReadAgeV1(at('2026-08-22T14:33:00.000Z'), new Date('2026-08-22T20:33:00.000Z'));
    assert.equal(age.label, '6h ago');
    assert.equal(age.stale, false);
  });

  test('the boundary is a full day, and it is inclusive', () => {
    const now = new Date('2026-08-22T20:33:00.000Z');
    assert.equal(trackedReadAgeV1(at('2026-08-21T20:33:01.000Z'), now).stale, false);
    assert.equal(trackedReadAgeV1(at('2026-08-21T20:33:00.000Z'), now).stale, true);
  });

  test('never read is not the same as stale', () => {
    const age = trackedReadAgeV1({ tokenAddress: '0xb20', lastSweptAt: null, lastOutcome: null }, new Date());
    assert.equal(age.label, null);
    // A token nobody has read is not old evidence — it is no evidence, and the
    // row already says "not read yet" rather than borrowing a staleness chip.
    assert.equal(age.stale, false);
  });

  test('an unparseable stamp claims neither freshness nor staleness', () => {
    const age = trackedReadAgeV1({ tokenAddress: '0xb20', lastSweptAt: 'whenever', lastOutcome: 'read' }, new Date());
    assert.equal(age.label, null);
    assert.equal(age.stale, false);
  });

  test('a future stamp does not produce a negative age', () => {
    const age = trackedReadAgeV1(at('2026-08-23T00:00:00.000Z'), new Date('2026-08-22T20:33:00.000Z'));
    assert.equal(age.label, 'just now');
    assert.equal(age.stale, false);
  });
});
