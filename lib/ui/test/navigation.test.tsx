import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  CONSOLE_DRAWER_SECTIONS_V1,
  CONSOLE_PIPELINE_STATES_V1,
  CONSOLE_PRIMARY_SECTIONS_V1,
  CONSOLE_SECTIONS_V1,
  CONSOLE_SECTION_TABLE_V1,
  CONSOLE_NO_ANALYSIS_TITLE_V1,
  consoleHomeSectionV1,
  consoleNavModelV1,
  consoleSectionFromPathV1,
  discoverFailureCopyV1,
  CONSOLE_DISCOVER_UNREACHABLE_COPY_V1,
  paidEvidenceStripV1,
  rightRailHasContentV1,
  type ConsolePipelineStateV1,
} from '../src/console/navigation';
import { ConsoleRightRail } from '../src/console/ConsoleScreens';
import { OpportunitiesScreen, type OpportunityCardViewV1 } from '../src/console/OpportunitiesScreen';
import { opportunityCardViewV1 } from '../src/console/opportunityCardView';

// The JSX below compiles to React.createElement.
void React;

const here = path.dirname(url.fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(path.join(here, relative), 'utf8');

// ---------------------------------------------------------------------------
// T70 §9 — the properties that survive a redesign.
//
// Almost everything here is about ONE failure: an empty screen that does not
// say why it is empty. A product with no scheduled workers and a product on a
// quiet chain look identical, and only one of them is working.
// ---------------------------------------------------------------------------

function pipeline(state: ConsolePipelineStateV1, message = 'because.') {
  return { state, message };
}

describe('§9.1 — Opportunities is home when there is something there', () => {
  test('a healthy pipeline with observations opens Opportunities, silently', () => {
    const home = consoleHomeSectionV1({
      pipeline: pipeline('healthy'),
      observationCount: 3,
      walletConnected: true,
    });
    assert.equal(home.section, 'opportunities');
    assert.equal(home.feedRenderable, true);
    // The ONE case that needs no explanation.
    assert.equal(home.notice, null);
  });

  test('a healthy but empty pipeline still opens Opportunities, and says so', () => {
    const home = consoleHomeSectionV1({
      pipeline: pipeline('healthy', 'Both workers are current.'),
      observationCount: 0,
      walletConnected: true,
    });
    assert.equal(home.section, 'opportunities');
    assert.equal(home.notice, 'Both workers are current.');
  });
});

describe('§9.2 — an unconfigured pipeline is never an empty feed', () => {
  test('configuration_required routes away and carries the reason', () => {
    const home = consoleHomeSectionV1({
      pipeline: pipeline('configuration_required', 'Discover needs an explicit start block.'),
      observationCount: 0,
      walletConnected: true,
    });
    // Portfolio works without Discover: it reads the chain for tokens already
    // held. Sending the user to a screen that can answer beats one that cannot.
    assert.equal(home.section, 'portfolio');
    assert.equal(home.feedRenderable, false);
    assert.equal(home.notice, 'Discover needs an explicit start block.');
  });

  test('with no wallet it routes to Routes instead, which needs none', () => {
    const home = consoleHomeSectionV1({
      pipeline: pipeline('storage_unavailable'),
      observationCount: 0,
      walletConnected: false,
    });
    assert.equal(home.section, 'routes');
  });

  test('an unreachable feed is not a quiet chain', () => {
    const home = consoleHomeSectionV1({ pipeline: null, observationCount: 0, walletConnected: false });
    assert.equal(home.section, 'routes');
    assert.equal(home.feedRenderable, false);
    assert.match(home.notice ?? '', /could not be reached/i);
  });

  test('every non-healthy state either routes away or speaks first', () => {
    // The exhaustive form. A new pipeline state added later cannot default to
    // rendering an empty list with nothing above it.
    for (const state of CONSOLE_PIPELINE_STATES_V1) {
      if (state === 'healthy') continue;
      const home = consoleHomeSectionV1({
        pipeline: pipeline(state),
        observationCount: 0,
        walletConnected: true,
      });
      assert.equal(home.feedRenderable, false, `${state} rendered an empty feed`);
      assert.ok(home.notice, `${state} said nothing`);
    }
  });

  test('the screen draws no empty state while the pipeline has something to say', () => {
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice="Discover needs an explicit historical start block."
        pipelineState="configuration_required"
        feedRenderable={false}
        cards={[]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    assert.match(markup, /explicit historical start block/);
    assert.ok(!/No measured B20 opportunities/.test(markup), 'an unconfigured pipeline rendered as an empty feed');
  });

  test('the healthy empty state is the only one that says "no opportunities"', () => {
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice={null}
        pipelineState="healthy"
        feedRenderable
        cards={[]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    assert.match(markup, /No measured B20 opportunities/);
    assert.match(markup, /Both workers are current/);
  });
});

describe('§9.5/§9.6 — the drawer is navigation, not a control panel', () => {
  const shell = read('../src/console/ConsoleShell.tsx');

  test('the drawer carries exactly five sections', () => {
    assert.equal(CONSOLE_DRAWER_SECTIONS_V1.length, 5);
    assert.deepEqual([...CONSOLE_DRAWER_SECTIONS_V1], [
      'opportunities',
      'portfolio',
      'routes',
      'proofs',
      'settings',
    ]);
  });

  test('the adapter list and the usage bars are gone from the shell', () => {
    // §3 — they were the two largest blocks in the drawer, and neither is
    // something a user acts on while planning a route.
    assert.ok(!shell.includes('Route adapters'), 'the adapter list is still in the rail');
    assert.ok(!shell.includes('usebar'), 'the usage bars are still in the rail');
    assert.ok(!shell.includes('Daily limit'), 'the limits row is still in the rail');
  });

  test('the adapter list is on Settings instead', () => {
    const settings = read('../src/console/SettingsScreen.tsx');
    assert.ok(settings.includes('Route adapters'));
    assert.ok(settings.includes('Providers'));
    assert.ok(settings.includes('Network status'));
    assert.ok(settings.includes('Technical details'));
  });

  test('Settings never lists an endpoint or a credential', () => {
    const settings = read('../src/console/SettingsScreen.tsx');
    assert.match(settings, /Endpoints and credentials are deliberately not listed/);
    for (const banned of ['RPC_URL', 'apiKey', 'API key', 'DATABASE_URL', 'authorization']) {
      assert.ok(!settings.toLowerCase().includes(banned.toLowerCase()), `Settings mentions ${banned}`);
    }
  });
});

describe('§9.7/§9.9 — one vocabulary, two surfaces', () => {
  test('Base App shows Opportunities, B20, Routes and Proofs', () => {
    const nav = consoleNavModelV1({ mounted: CONSOLE_PRIMARY_SECTIONS_V1, active: 'opportunities' });
    assert.deepEqual(nav.map((item) => item.compactLabel), ['Opportunities', 'B20', 'Routes', 'Proofs']);
  });

  test('the compact labels are in the shared table, not typed into the miniapp', () => {
    const mini = read('../../../artifacts/miniapp/app/components/MiniConsole.tsx');
    assert.ok(mini.includes('consoleNavModelV1'), 'the miniapp builds its own nav');
    // The four words must not appear as bare navigation strings in the miniapp.
    for (const section of CONSOLE_PRIMARY_SECTIONS_V1) {
      const compact = CONSOLE_SECTION_TABLE_V1[section].compactLabel;
      assert.ok(
        !new RegExp(`(label|compactLabel):\\s*["']${compact}["']`).test(mini),
        `the miniapp hard-codes "${compact}"`,
      );
    }
  });

  test('both surfaces use the same order', () => {
    assert.deepEqual([...CONSOLE_PRIMARY_SECTIONS_V1], ['opportunities', 'portfolio', 'routes', 'proofs']);
  });

  test('every section has a static path with no wallet state in it', () => {
    // §8 — the section is in the URL, because that is what survives a refresh.
    // Nothing else is: an address in a path is an address in a browser history,
    // a referrer header and a shared link.
    for (const section of CONSOLE_SECTIONS_V1) {
      const { path: sectionPath } = CONSOLE_SECTION_TABLE_V1[section];
      assert.match(sectionPath, /^\/[a-z/-]+$/, `${section} has a non-static path`);
      assert.ok(!/0x|:|address|wallet/.test(sectionPath), `${section} carries wallet state`);
      assert.equal(consoleSectionFromPathV1(sectionPath), section);
    }
  });

  test('the old paths still resolve to a section', () => {
    // A bookmark from before this task is not a reason to show no active tab.
    assert.equal(consoleSectionFromPathV1('/'), 'routes');
    assert.equal(consoleSectionFromPathV1('/b20'), 'portfolio');
    assert.equal(consoleSectionFromPathV1('/portfolio?token=0xabc'), 'portfolio');
    assert.equal(consoleSectionFromPathV1('/nowhere'), null);
  });

  test('the mirrored pipeline states match lib/opportunity-rail exactly', () => {
    // lib/ui cannot import opportunity-rail: the miniapp compiles this package
    // at ES2017 and that barrel reaches BigInt literals. So the list is copied,
    // and this reads the original off disk to make sure the copy cannot rot.
    const source = read('../../opportunity-rail/src/discoverFeed.ts');
    const block = source.slice(
      source.indexOf('export const B20_PIPELINE_STATES_V1'),
      source.indexOf('] as const;', source.indexOf('export const B20_PIPELINE_STATES_V1')),
    );
    const states = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    assert.deepEqual(states, [...CONSOLE_PIPELINE_STATES_V1]);
  });
});

describe('§9.8 — an unwired section gets no button', () => {
  test('a section that is not mounted does not appear at all', () => {
    const nav = consoleNavModelV1({ mounted: ['routes', 'proofs'], active: 'routes' });
    assert.deepEqual(nav.map((item) => item.id), ['routes', 'proofs']);
  });

  test('a mounted-but-unusable section is present, inert and explained', () => {
    const nav = consoleNavModelV1({
      mounted: CONSOLE_PRIMARY_SECTIONS_V1,
      active: 'opportunities',
      unavailable: { opportunities: 'Discover is off on this server.' },
    });
    const opportunities = nav.find((item) => item.id === 'opportunities')!;
    assert.equal(opportunities.available, false);
    // Never the active tab: navigating to a surface that cannot answer leaves
    // the user staring at a blank column.
    assert.equal(opportunities.active, false);
    assert.equal(opportunities.unavailableReason, 'Discover is off on this server.');
  });

  test('an available section always has a null reason', () => {
    const nav = consoleNavModelV1({ mounted: CONSOLE_PRIMARY_SECTIONS_V1, active: 'routes' });
    for (const item of nav) {
      assert.equal(item.available, true);
      assert.equal(item.unavailableReason, null);
    }
  });

  test('the shell renders an unavailable section without a button', () => {
    const shell = read('../src/console/ConsoleShell.tsx');
    // The ternary is the mechanism: `item.available ? <button/> : <span/>`.
    assert.match(shell, /item\.available \? \(/);
    assert.match(shell, /item\.unavailableReason/);
  });
});

describe('§9.12 — the empty right rail is one block, not five', () => {
  test('nothing measured collapses to a single named panel', () => {
    const markup = renderToStaticMarkup(
      <ConsoleRightRail
        price={null}
        priceUnavailableReason={null}
        depth={null}
        depthUnavailableReason={null}
        evidenceFeed={[]}
        spend={null}
        freshness={[]}
      />,
    );
    assert.match(markup, new RegExp(CONSOLE_NO_ANALYSIS_TITLE_V1));
    // Four separate "unavailable" headings read as four separate failures.
    for (const heading of ['Pool depth', 'Evidence stream', 'Intelligence spend', 'Freshness']) {
      assert.ok(!markup.includes(heading), `${heading} still renders its own empty panel`);
    }
  });

  test('one piece of real data brings every panel back', () => {
    assert.equal(
      rightRailHasContentV1({
        price: null,
        depth: null,
        spend: null,
        evidenceFeed: [],
        freshness: [{ label: 'Quote age', value: '3s' }],
      }),
      true,
    );
    const markup = renderToStaticMarkup(
      <ConsoleRightRail
        price={null}
        priceUnavailableReason="No price source connected."
        depth={null}
        depthUnavailableReason="No depth source connected."
        evidenceFeed={[]}
        spend={null}
        freshness={[{ label: 'Quote age', value: '3s' }]}
      />,
    );
    assert.match(markup, /Pool depth/);
    assert.match(markup, /Freshness/);
    assert.ok(!markup.includes(CONSOLE_NO_ANALYSIS_TITLE_V1));
  });
});

describe('§9.11 — the first mobile screen is the work, not the settings', () => {
  test('Opportunities puts the pipeline and the cards first', () => {
    // A structural proxy for "visible without scrolling": what a rendering test
    // can actually assert is ORDER, and the failure T70 fixes was ordering —
    // Budget & payments was the first block on the page.
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice="Catching up: block 49,420,000 of 49,531,000."
        pipelineState="ingestion_catching_up"
        feedRenderable={false}
        cards={[]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    assert.ok(markup.indexOf('Catching up') < 200, 'the pipeline status is not the first thing on the page');
    for (const banned of ['Budget', 'Spend permission', 'Route adapters']) {
      assert.ok(!markup.includes(banned), `${banned} is on the first mobile screen`);
    }
  });

  test('the miniapp tab bar is a grid of equal columns, so it cannot scroll sideways', () => {
    const css = read('../src/console/console.css');
    const bar = css.slice(css.indexOf('.mio-console .tabbar {'));
    assert.match(bar, /grid-auto-columns: 1fr/);
    assert.match(bar, /text-overflow: ellipsis/);
  });

  test('a card wraps inside its own width', () => {
    const css = read('../src/console/console.css');
    assert.match(css, /\.cardrow \.cr-name, [^{]*\.cardrow \.cr-v \{ overflow-wrap: anywhere/);
  });
});

describe('§2 — the compact paid-evidence status', () => {
  test('it states what still works, always', () => {
    const strip = paidEvidenceStripV1({
      label: 'Not enabled',
      moneyAtRisk: false,
      needsPermission: false,
      permissionFlowAvailable: false,
      settingsAvailable: true,
    });
    assert.equal(strip.label, 'Paid evidence: Not enabled');
    assert.equal(strip.detail, 'Free comparison available');
    assert.equal(strip.permissionNotice, null);
  });

  test('a missing permission flow is stated, not offered as a button', () => {
    const strip = paidEvidenceStripV1({
      label: 'Not configured',
      moneyAtRisk: false,
      needsPermission: true,
      permissionFlowAvailable: false,
      settingsAvailable: true,
    });
    assert.match(strip.permissionNotice ?? '', /not available yet/);
  });

  test('money at risk changes the sentence', () => {
    const strip = paidEvidenceStripV1({
      label: 'Paid, not delivered',
      moneyAtRisk: true,
      needsPermission: false,
      permissionFlowAvailable: false,
      settingsAvailable: true,
    });
    assert.match(strip.detail, /reconciliation/i);
  });
});

describe('§9.13 — nothing in this task touches execution', () => {
  test('the new surfaces contain no signer, no submission and no clearance', () => {
    for (const file of [
      '../src/console/navigation.ts',
      '../src/console/OpportunitiesScreen.tsx',
      '../src/console/SettingsScreen.tsx',
      '../src/console/opportunityCardView.ts',
      '../../../artifacts/interface/src/features/opportunities/OpportunitiesPage.tsx',
    ]) {
      const source = read(file);
      for (const banned of [
        'privateKey',
        'signTransaction',
        'sendCalls',
        'eth_sendRawTransaction',
        'prepare-entry',
        'usePrepareEntry',
        'clearanceId',
      ]) {
        assert.ok(!source.includes(banned), `${file} mentions ${banned}`);
      }
    }
  });

  test('Review, submission and reconciliation still run from the console', () => {
    const console_ = read('../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx');
    for (const kept of [
      'ReviewScreen',
      'BlueprintSubmitButton',
      'SubmissionRecoveryRail',
      'useBoundedProofReconciliation',
      'SimulateButton',
    ]) {
      assert.ok(console_.includes(kept), `the console lost ${kept}`);
    }
  });

  test('Opportunities hands a token over rather than qualifying it', () => {
    const page = read('../../../artifacts/interface/src/features/opportunities/OpportunitiesPage.tsx');
    assert.match(page, /consoleSectionPathV1\('portfolio'\)/);
    assert.ok(!page.includes('useB20OpportunitySimulate'), 'Discover grew a qualification path');
  });
});

// ---------------------------------------------------------------------------
// The card projection. §10 of T69-C, enforced where it is actually rendered.
// ---------------------------------------------------------------------------

function wireCard(overrides: Record<string, unknown> = {}) {
  return {
    launch: {
      tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
      name: 'o1 mascot',
      symbol: 'DINo1',
      variant: 'asset' as const,
      decimals: 18,
      ageSeconds: 900,
      canonical: true,
    },
    observation: {
      state: 'provisional' as const,
      headline: 'A round trip priced under your tolerance.',
      detail: 'Both legs quoted.',
      referencePositionAtomic: '100000000',
      maxRoundTripBps: 300,
      optimisticRoundTripBps: 118,
      largestPassingSizeAtomic: '4000000000000000000000',
      firstFailingSizeAtomic: '8000000000000000000000',
      capacityStable: true,
      transferPolicyNotice: null,
      quoteAlignmentNotice: 'Controls are block-anchored. Market quotes were read at latest.',
      preEntryNotice: 'Pre-entry estimate.',
      freshness: 'fresh' as const,
    },
    canCheckProfile: true,
    notMeasured: ['unique buyers', 'trading volume'],
    ...overrides,
  };
}

describe('a card never turns a missing measurement into a number', () => {
  test('an unmeasured cost stays null all the way to the view', () => {
    const view = opportunityCardViewV1(
      wireCard({ observation: { ...wireCard().observation, optimisticRoundTripBps: null, largestPassingSizeAtomic: null } }),
    );
    assert.equal(view.costLabel, null);
    assert.equal(view.capacityLabel, null);
  });

  test('a never-measured launch says so instead of showing zeros', () => {
    const view = opportunityCardViewV1(wireCard({ observation: null }));
    assert.equal(view.state, 'unmeasured');
    assert.equal(view.costLabel, null);
    assert.equal(view.capacityLabel, null);
    assert.match(view.headline, /Not measured/);
  });

  test('the screen renders "not measured", never 0.00%', () => {
    const view = opportunityCardViewV1(wireCard({ observation: null }));
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice={null}
        pipelineState="healthy"
        feedRenderable
        cards={[view] as OpportunityCardViewV1[]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    assert.match(markup, /not measured/);
    assert.ok(!/0\.00%/.test(markup), 'an unmeasured token rendered a zero cost');
  });

  test('capacity is a bound, never a point between two probes', () => {
    const view = opportunityCardViewV1(wireCard());
    assert.equal(view.capacityLabel, 'at least 4000 DINo1 · fails by 8000 DINo1');
    // No interpolated figure exists anywhere between the two rungs.
    assert.ok(!/^\d/.test(view.capacityLabel ?? ''), 'capacity reads as an exact quantity');
  });

  test('unknown decimals are stated rather than assumed', () => {
    const view = opportunityCardViewV1(
      wireCard({ launch: { ...wireCard().launch, decimals: null } }),
    );
    assert.match(view.capacityLabel ?? '', /atomic/);
  });

  test('a stale card keeps its numbers and loses its action', () => {
    // §13 — freshness gates the ACTION, not the facts. A stale measurement is
    // still what was true when it was taken.
    const view = opportunityCardViewV1(wireCard({ canCheckProfile: false }));
    assert.equal(view.costLabel, '1.18%');
    assert.match(view.actionUnavailableReason ?? '', /freshness window/);
  });

  test('the disabled action is words, not a dimmed button', () => {
    const view = opportunityCardViewV1(wireCard({ canCheckProfile: false }));
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice={null}
        pipelineState="healthy"
        feedRenderable
        cards={[view] as OpportunityCardViewV1[]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    assert.match(markup, /freshness window/);
    assert.ok(!/Check against my wallet/.test(markup), 'a stale card still offered the action');
  });

  test('every notice reaches the card', () => {
    const view = opportunityCardViewV1(
      wireCard({
        observation: { ...wireCard().observation, transferPolicyNotice: 'A transfer policy is active.' },
      }),
    );
    assert.deepEqual(view.notices, [
      'Pre-entry estimate.',
      'Controls are block-anchored. Market quotes were read at latest.',
      'A transfer policy is active.',
    ]);
  });

  test('no card ever says safe, unsafe or scored', () => {
    const screen = read('../src/console/OpportunitiesScreen.tsx');
    const view = read('../src/console/opportunityCardView.ts');
    for (const banned of ['safe', 'unsafe', 'security score', 'risk score', 'trending', 'recommended']) {
      for (const [name, source] of [['screen', screen], ['view', view]] as const) {
        assert.ok(
          !new RegExp(`['"\`][^'"\`]*\\b${banned}\\b`, 'i').test(source),
          `the ${name} says "${banned}"`,
        );
      }
    }
  });
});

describe('a failed feed request names its own cause', () => {
  test('four unrelated problems get four different sentences', () => {
    // They all rendered as "Discover could not be reached", which is true of
    // every one of them and useful for none.
    const seen = new Set<string>();
    for (const error of [
      new Error('API error: 404 Not Found'),
      new Error('authentication_required'),
      new Error('b20_control_disabled'),
      new Error('storage_unavailable'),
      Object.assign(new Error('invalid_type at cards[0]'), { name: 'ZodError' }),
      new Error('API error: 502 Bad Gateway'),
    ]) {
      const copy = discoverFailureCopyV1(error);
      assert.ok(copy.length > 0);
      assert.equal(seen.has(copy), false, `two causes share a sentence: ${copy}`);
      seen.add(copy);
    }
  });

  test('a server missing the routes says so, rather than blaming the chain', () => {
    const copy = discoverFailureCopyV1(new Error('API error: 404 Not Found'));
    assert.match(copy, /newer build/);
    assert.match(copy, /nothing is wrong with the chain/i);
  });

  test('an unrecognised failure falls back rather than echoing the server', () => {
    // A server error can carry an endpoint, and an endpoint can carry a key.
    const copy = discoverFailureCopyV1(new Error('connect ECONNREFUSED 10.0.0.4:8080'));
    assert.equal(copy, CONSOLE_DISCOVER_UNREACHABLE_COPY_V1);
    assert.ok(!copy.includes('10.0.0.4'));
  });
});
