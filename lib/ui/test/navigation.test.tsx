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
  consoleIndexStatusV1,
  consoleNavModelV1,
  consolePipelineNoticeLeadsV1,
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
import { B20_STANDING_GROUP_COPY_V1 } from '@mioagent/opportunity-rail/exitStanding';

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

  test('the drawer carries the three tabs plus Activity, Extensions and Settings', () => {
    // Activity and Extensions are here and NOT in the tab bar. Neither is
    // where work starts, and a bar of three working surfaces is more honest
    // than four where one is a viewer for records nobody has produced.
    assert.equal(CONSOLE_DRAWER_SECTIONS_V1.length, 6);
    assert.deepEqual([...CONSOLE_DRAWER_SECTIONS_V1], [
      'opportunities',
      'portfolio',
      'routes',
      'activity',
      'extensions',
      'settings',
    ]);
  });

  test('every drawer section is reachable, so the drawer is the complete map', () => {
    // Dropping a tab from the bar is only safe if the drawer still lists it.
    for (const section of CONSOLE_SECTIONS_V1) {
      assert.ok(
        (CONSOLE_DRAWER_SECTIONS_V1 as readonly string[]).includes(section),
        `${section} is reachable from nowhere`,
      );
    }
  });

  test('the header carries one navigation, not a shorter copy of the rail', () => {
    // The header used to render the three primary sections as pills beside a
    // breadcrumb. The rail lists all six and is on screen at every width — a
    // column above 900px, the drawer below it — so the pills were a second,
    // shorter copy of the same navigation. On Discover they put the active
    // pill directly beside a breadcrumb reading the same word.
    assert.ok(
      !shell.includes('className="crumb" aria-label="Sections"'),
      'the header still renders section pills',
    );
    assert.ok(shell.includes('aria-label="Breadcrumb"'), 'the breadcrumb went with them');
    // The rail's own Sections nav stays — that is the navigation that remained.
    assert.ok(shell.includes('className="railnav" aria-label="Sections"'));
    // `header.nav` is still accepted: the rail falls back to it.
    assert.ok(shell.includes('left.nav ?? header.nav'), 'the rail lost its fallback');
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
  test('Base App shows Discover, B20 and Routes AI', () => {
    const nav = consoleNavModelV1({ mounted: CONSOLE_PRIMARY_SECTIONS_V1, active: 'opportunities' });
    assert.deepEqual(nav.map((item) => item.compactLabel), ['Discover B20', 'B20', 'Routes AI']);
  });

  test('Routes and the Base MCP extension layer are named apart', () => {
    // They answer with different guarantees — a measured Route Card versus
    // whatever a third-party tool returned — so they must not read as one
    // feature split across two tabs.
    assert.equal(CONSOLE_SECTION_TABLE_V1.routes.label, 'Routes AI');
    assert.equal(CONSOLE_SECTION_TABLE_V1.extensions.label, 'Base MCP Extensions');
    assert.equal(CONSOLE_SECTION_TABLE_V1.extensions.compactLabel, 'MCP Extensions');
  });

  test('no tab is named for something that only exists after a signature', () => {
    // "Proofs" promised the one row this deployment has never produced. The
    // same gap Portfolio/Discover had: a surface named for its rarest state.
    for (const section of CONSOLE_SECTIONS_V1) {
      assert.notEqual(CONSOLE_SECTION_TABLE_V1[section].label, 'Proofs');
    }
    assert.equal(CONSOLE_SECTION_TABLE_V1.activity.label, 'Activity');
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
    assert.deepEqual([...CONSOLE_PRIMARY_SECTIONS_V1], ['opportunities', 'portfolio', 'routes']);
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
    const nav = consoleNavModelV1({ mounted: ['routes', 'activity'], active: 'routes' });
    assert.deepEqual(nav.map((item) => item.id), ['routes', 'activity']);
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
      blockNumber: '49531000',
      ageSeconds: 900,
      launchTimeSource: 'onchain_block' as const,
      canonical: true,
    },
    observation: {
      observationId: `0x${'a'.repeat(64)}`,
      evidenceHash: `0x${'b'.repeat(64)}`,
      state: 'provisional' as const,
      headline: 'A round trip priced under your tolerance.',
      detail: 'Both legs quoted.',
      referencePositionAtomic: '100000000',
      maxRoundTripBps: 300,
      entryRouteFound: true,
      exitRouteFound: true,
      entrySourceKey: 'aerodrome|usdc>token:volatile',
      exitSourceKey: 'aerodrome|token>usdc:volatile',
      routeCoverage: 'complete' as const,
      optimisticRoundTripBps: 118,
      largestPassingSizeAtomic: '4000000000000000000000',
      firstFailingSizeAtomic: '8000000000000000000000',
      capacityStable: true,
      transferPolicyNotice: null,
      quoteAlignmentNotice: 'Controls are block-anchored. Market quotes were read at latest.',
      preEntryNotice: 'Pre-entry estimate.',
      launchBuyers: null,
      observationBlockNumber: '49531100',
      freshness: 'fresh' as const,
    },
    canCheckProfile: true,
    action: {
      action: 'check_wallet' as const,
      label: 'Check against my wallet',
      reason: 'Measured before any entry moved the pool. Your own check runs the entry and exit in sequence.',
    },
    notMeasured: ['unique buyers', 'trading volume'],
    ...overrides,
  };
}

describe('a card never turns a missing measurement into a number', () => {
  test('the view preserves the exact observation references for Ask this card', () => {
    const view = opportunityCardViewV1(wireCard());
    assert.equal(view.observationId, `0x${'a'.repeat(64)}`);
    assert.equal(view.evidenceHash, `0x${'b'.repeat(64)}`);
    assert.equal(view.observationBlockNumber, '49531100');
  });

  test('an unmeasured cost stays null all the way to the view', () => {
    const view = opportunityCardViewV1(
      wireCard({ observation: { ...wireCard().observation, optimisticRoundTripBps: null, largestPassingSizeAtomic: null } }),
    );
    assert.equal(view.costLabel, null);
    assert.equal(view.capacityLabel, null);
  });

  test('the position is labelled in the asset it was measured in', () => {
    // B20's v4 pools are quoted against native ETH. Printing 0.03 ETH as
    // "30000000000000000" with six decimals and a USDC suffix would be wrong
    // by twelve orders of magnitude and name the wrong currency.
    const eth = opportunityCardViewV1(
      wireCard({
        observation: {
          ...wireCard().observation,
          referenceQuoteAsset: '0x0000000000000000000000000000000000000000',
          referencePositionAtomic: '30000000000000000',
        },
      }),
    );
    assert.match(eth.profileLabel ?? "", /0\.03 ETH/);

    const usdc = opportunityCardViewV1(
      wireCard({
        observation: {
          ...wireCard().observation,
          referenceQuoteAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          referencePositionAtomic: '100000000',
        },
      }),
    );
    assert.match(usdc.profileLabel ?? "", /100 USDC/);
  });

  test('a never-measured launch says so instead of showing zeros', () => {
    const view = opportunityCardViewV1(wireCard({ observation: null }));
    assert.equal(view.state, 'unmeasured');
    assert.equal(view.costLabel, null);
    assert.equal(view.capacityLabel, null);
    assert.match(view.headline, /Not measured/);
    // The profile row is HIDDEN rather than told it has nothing to say. One
    // unmeasured card used to state "not measured" five separate times.
    assert.equal(view.profileLabel, null);
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
    // Case-insensitive: the old amber pill said "not measured" in lower case,
    // the consumer status chip says "Not measured yet". The assertion is that
    // the screen SAYS it, not how it capitalises it.
    assert.match(markup, /not measured/i);
    assert.match(markup, /Round trip \+ exit capacity/);
    // A BOUND, not an exact count. The point of this assertion is that one
    // unmeasured card must not say "not measured" five separate times; pinning
    // the exact number made a change that says it LESS fail the test. The
    // consumer card says it twice — a status chip and the missing-metric row.
    const repeats = (markup.match(/not measured/gi) ?? []).length;
    assert.ok(repeats >= 1 && repeats <= 3, `"not measured" appears ${repeats} times`);
    assert.ok(!/0\.00%/.test(markup), 'an unmeasured token rendered a zero cost');
  });

  test('a stored degraded observation uses one compact state instead of two empty metrics', () => {
    const view = opportunityCardViewV1(
      wireCard({
        observation: {
          ...wireCard().observation,
          state: 'unmeasured',
          headline: 'The route search did not complete.',
          detail: 'Too many route candidates went unanswered.',
          optimisticRoundTripBps: null,
          largestPassingSizeAtomic: null,
          firstFailingSizeAtomic: null,
          capacityStable: null,
        },
      }),
    );
    assert.ok(view.profileLabel, 'the stored observation still names its profile');
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice={null}
        pipelineState="healthy"
        feedRenderable
        cards={[view]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    assert.match(markup, /measurement-missing/);
    assert.match(markup, /Round trip \+ exit capacity/);
    assert.ok(!markup.includes('cr-nums'), 'the empty two-column metrics block returned');
  });

  test('Discover explains each measured dimension without claiming a score', () => {
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice={null}
        pipelineState="healthy"
        feedRenderable
        cards={[opportunityCardViewV1(wireCard())]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    assert.match(markup, /How to read a B20 card/);
    assert.match(markup, /Every card is built around a B20 token/);
    assert.match(markup, /not a general token scanner/);
    for (const label of ['Round trip', 'Exit capacity', 'Route liquidity', 'Bought at launch']) {
      assert.match(markup, new RegExp(label));
    }
    assert.match(markup, /does not predict returns/);
    assert.match(markup, /does not.*combined rating/);
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
    const view = opportunityCardViewV1(
      wireCard({
        canCheckProfile: false,
        action: { action: 'refresh_measurement', label: 'Refresh measurement', reason: 'past its freshness window' },
      }),
    );
    assert.equal(view.costLabel, '1.18%');
    assert.equal(view.actionLabel, 'Refresh measurement');
  });

  test('the disabled action is words, not a dimmed button', () => {
    const view = opportunityCardViewV1(
      wireCard({
        canCheckProfile: false,
        action: {
          action: 'none',
          label: null,
          reason: 'This is a fact about the token at the measured block, not about any particular wallet.',
        },
      }),
    );
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
    assert.match(markup, /not about any particular wallet/);
    assert.ok(!/Check against my wallet/.test(markup), 'a wallet-independent card still offered the action');
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

  test('launch-buyer evidence is read from the API observation shape', () => {
    const view = opportunityCardViewV1(
      wireCard({
        observation: {
          ...wireCard().observation,
          launchBuyers: {
            buyerCount: 23,
            topBuyerShareBps: 2426,
            topThreeShareBps: 5160,
          },
        },
      }),
    );
    assert.match(view.buyersLabel ?? '', /23 wallets/);
    assert.match(view.buyersLabel ?? '', /24\.26%/);
  });

  test('an open launch-buyer window is visible without inventing a partial count', () => {
    const view = opportunityCardViewV1(
      wireCard({
        observation: {
          ...wireCard().observation,
          launchBuyers: null,
          launchBuyerWindow: { status: 'collecting', closesAtBlock: '49541000' },
        },
      }),
    );
    assert.equal(view.buyersLabel, 'Collecting');
    assert.match(view.buyersNote ?? '', /block 49541000/);
    assert.ok(!/\b0\b/.test(view.buyersLabel ?? ''), 'an open buyer window rendered a zero count');
  });

  test('a one-sided route explains why cost and capacity are not measured', () => {
    const view = opportunityCardViewV1(
      wireCard({
        observation: {
          ...wireCard().observation,
          entryRouteFound: true,
          exitRouteFound: false,
          exitSourceKey: null,
          optimisticRoundTripBps: null,
          largestPassingSizeAtomic: null,
        },
      }),
    );
    assert.equal(view.routeLabel, 'Entry found · exit missing');
    assert.match(view.routeNote ?? '', /Aerodrome/);
    assert.match(view.routeNote ?? '', /stay unmeasured/);
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

describe('Ask this B20 card stays an evidence read', () => {
  test('the card offers Ask Miorail without adding a wallet action', () => {
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice={null}
        pipelineState="healthy"
        feedRenderable
        cards={[opportunityCardViewV1(wireCard())]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
        copilot={{
          tokenAddress: null,
          loading: false,
          answer: null,
          error: null,
          onAsk: () => undefined,
          onOpenRoutes: () => undefined,
        }}
      />,
    );
    assert.match(markup, /Ask Miorail/);
    assert.match(markup, /aria-expanded="false"/);
    assert.ok(!markup.includes('wallet_sendCalls'));
  });

  test('both product surfaces use the same copilot hook and shared screen', () => {
    const web = read('../../../artifacts/interface/src/features/opportunities/OpportunitiesPage.tsx');
    const mini = read('../../../artifacts/miniapp/app/components/MiniConsole.tsx');
    for (const source of [web, mini]) {
      assert.match(source, /useB20CopilotAsk/);
      assert.match(source, /<OpportunitiesScreen/);
      assert.match(source, /schemaVersion: ["']b20-copilot-ask\/v1["']/);
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

// ---------------------------------------------------------------------------
// T69-C.1 §1/§2/§3 — at the surface.
// ---------------------------------------------------------------------------

describe('T69-C.1 §1 — a card never calls detection time a launch time', () => {
  test('a real block timestamp is labelled "Launched"', () => {
    const view = opportunityCardViewV1(wireCard());
    assert.equal(view.timeLabel, 'Launched');
    assert.equal(view.timeValue, '15 min ago');
  });

  test('without one, the card names the block instead of inventing a time', () => {
    const view = opportunityCardViewV1(
      wireCard({
        launch: { ...wireCard().launch, ageSeconds: null, launchTimeSource: 'discovered' as const },
      }),
    );
    assert.equal(view.timeLabel, 'Discovered by Miorail');
    assert.equal(view.timeValue, 'block 49531000');
    // Never a relative age: with the worker days behind, "15 min ago" was a
    // claim about the backlog wearing a claim about the token.
    assert.ok(!/ago/.test(view.timeValue));
  });

  test('the rendered card shows the honest label, not "Launched"', () => {
    const view = opportunityCardViewV1(
      wireCard({
        launch: { ...wireCard().launch, ageSeconds: null, launchTimeSource: 'discovered' as const },
      }),
    );
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
    assert.match(markup, /Discovered by Miorail/);
    assert.ok(!/>Launched</.test(markup));
  });
});

describe('T69-C.1 §2/§3 — the card renders the server’s action, and only that', () => {
  function render(action: OpportunityCardViewV1['actionLabel'], reason: string) {
    const view = opportunityCardViewV1(
      wireCard({ action: { action: action ? 'check_wallet' : 'none', label: action, reason } }),
    );
    return renderToStaticMarkup(
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
  }

  test('§3 — a wallet-independent rejection renders its reason and no button', () => {
    const markup = render(null, 'This is a fact about the token, not about any particular wallet.');
    assert.match(markup, /not about any particular wallet/);
    assert.ok(!/<button[^>]*>Check against my wallet/.test(markup));
  });

  test('the label comes from the server, so a new action needs no UI change', () => {
    // "Try another profile" and "Refresh measurement" render through the same
    // path as the wallet check. The view never decides which is appropriate —
    // one implementation of "may a wallet overturn this?" is one too many.
    for (const label of ['Try another profile', 'Refresh measurement', 'Check against my wallet']) {
      assert.match(render(label, 'because the measurement says so, at length.'), new RegExp(label));
    }
  });

  test('the reason is shown whether or not there is a button', () => {
    assert.match(render(null, 'A reason long enough to be a sentence.'), /A reason long enough/);
    assert.match(render('Refresh measurement', 'A reason long enough to be a sentence.'), /A reason long enough/);
  });

  test('the view cannot manufacture an action the server did not send', () => {
    const source = read('../src/console/opportunityCardView.ts');
    // No local rule about freshness, reasons or wallets: the field is copied.
    assert.ok(!source.includes('canCheckProfile ?'), 'the view re-derives the action');
    assert.ok(!/no_exit_route|transfers_paused/.test(source), 'the view knows rejection reasons');
  });
});

// ---------------------------------------------------------------------------
// Index coverage is not measurement coverage.
//
// After the historical backfill, Discover opened with "22,265 launches have
// been found and are waiting for Exit-First measurement" — true, and read as
// "Miorail found 22k tokens and did nothing with them". What had actually
// happened is that the index reached B20 genesis.
// ---------------------------------------------------------------------------
describe('the index says what it covers, and never divides one count by another', () => {
  const facts = {
    canonicalLaunchCount: 28_806,
    launchesAwaitingMeasurement: 22_265,
    observationCount: 6_931,
    ingestionCursorBlock: '50054269',
    confirmedHead: '50054269',
  };

  test('a measurement backlog does not make the index look unfinished', () => {
    const status = consoleIndexStatusV1({ state: 'measurement_pending', facts })!;
    assert.equal(status.headline, 'B20 index synced');
    assert.match(status.tracked ?? '', /28,806 launches tracked/);
    assert.match(status.cursor ?? '', /Caught up to Base block 50,054,269/);
    // And the backlog is still there, exactly, one level down.
    assert.equal(
      status.details.find((row) => row.label === 'Awaiting first measurement')?.value,
      '22,265',
    );
  });

  test('the pipeline sentence stops leading only for the backlog state', () => {
    assert.equal(consolePipelineNoticeLeadsV1('measurement_pending'), false);
    for (const state of CONSOLE_PIPELINE_STATES_V1) {
      if (state === 'measurement_pending') continue;
      assert.equal(consolePipelineNoticeLeadsV1(state), true, `${state} must keep its sentence on top`);
    }
    // Unknown state: the sentence leads. A surface that has not resolved the
    // pipeline may not decide a message is unimportant.
    assert.equal(consolePipelineNoticeLeadsV1(null), true);
  });

  test('no percentage, no share and no arithmetic between the two counts', () => {
    const status = consoleIndexStatusV1({ state: 'measurement_pending', facts })!;
    const surface = [
      status.headline,
      status.tracked ?? '',
      status.cursor ?? '',
      status.detailNote,
      ...status.details.flatMap((row) => [row.label, row.value]),
    ].join(' | ');
    assert.ok(!/%/.test(surface), 'the index status printed a percentage');
    // 28,806 − 22,265 = 6,541. It is not a measured-launch count: the awaiting
    // figure is scoped to the measurement worker's own window and the launch
    // count is not, so the difference is a number nobody counted.
    assert.ok(!/6,541/.test(surface), 'the index status invented a measured count');
    assert.ok(!/covered|complete|all b20|fully measured/i.test(surface));
    // The sentence that stops the four counts being read as a coverage ratio.
    assert.match(status.detailNote, /separate stages/i);
    assert.match(status.detailNote, /observations rather than launches/i);
  });

  test('every state gets an index headline, and only current ones say synced', () => {
    const synced = new Set(['healthy', 'measurement_pending', 'degraded']);
    for (const state of CONSOLE_PIPELINE_STATES_V1) {
      const status = consoleIndexStatusV1({ state, facts })!;
      assert.ok(status.headline.length > 0, `${state} has no headline`);
      assert.equal(
        /synced/.test(status.headline),
        synced.has(state),
        `${state} claims the wrong thing about the index`,
      );
    }
  });

  test('a behind or stopped index never claims to be caught up to a block', () => {
    for (const state of ['ingestion_catching_up', 'worker_stale', 'ingestion_not_started'] as const) {
      assert.equal(consoleIndexStatusV1({ state, facts })!.cursor, null, `${state} claimed a caught-up block`);
    }
  });

  test('no pipeline state and no facts produce no index status at all', () => {
    // Claiming coverage from an unanswered request is the guess this whole
    // surface exists to stop making.
    assert.equal(consoleIndexStatusV1({ state: null, facts }), null);
    assert.equal(consoleIndexStatusV1({ state: 'healthy', facts: null }), null);
  });

  test('an empty feed keeps the backlog sentence on top, where it explains the emptiness', () => {
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice="22,265 launches have been found and are waiting for Exit-First measurement."
        pipelineState="measurement_pending"
        pipelineNoticeLeads={false}
        indexStatus={consoleIndexStatusV1({ state: 'measurement_pending', facts })}
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
    // With nothing in the feed it is the only sentence explaining an empty
    // screen, and an explanation a reader must expand is not one.
    assert.match(markup, /class="note">22,265 launches have been found/);
    assert.match(markup, /B20 index synced/);
  });
});

describe('what the sections say about a gap', () => {
  test('a measurement gap is not presented as a list of errors', () => {
    // 25 of 25 cards on the live first page sat under "Miorail could not
    // measure these", which turns the product into a list of its own failures.
    // The invariant is unchanged: the sentence is still about Miorail.
    const copy = B20_STANDING_GROUP_COPY_V1.miorail_limit;
    assert.equal(copy.label, 'Needs more evidence');
    assert.ok(!/could not measure/i.test(copy.label));
    assert.match(copy.note, /Miorail could not fully establish/);
    assert.match(copy.note, /measurement gaps, not findings about the tokens/);
    // And it still never reads as a verdict on a token.
    for (const word of ['failed', 'bad', 'rejected', 'unsafe', 'avoid']) {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(copy.label + ' ' + copy.note), `the section says "${word}"`);
    }
  });

  test('a feed with cards moves the backlog sentence under Index details', () => {
    const markup = renderToStaticMarkup(
      <OpportunitiesScreen
        pipelineNotice="22,265 launches have been found and are waiting for Exit-First measurement."
        pipelineState="measurement_pending"
        pipelineNoticeLeads={false}
        indexStatus={consoleIndexStatusV1({
          state: 'measurement_pending',
          facts: {
            canonicalLaunchCount: 28_806,
            launchesAwaitingMeasurement: 22_265,
            observationCount: 6_931,
            ingestionCursorBlock: '50054269',
            confirmedHead: '50054269',
          },
        })}
        feedRenderable
        cards={[opportunityCardViewV1(wireCard())]}
        filter="all"
        freshOnly={false}
        loading={false}
        onFilterChange={() => undefined}
        onFreshOnlyChange={() => undefined}
        onOpenToken={() => undefined}
      />,
    );
    // Present, and not in the panel's leading position.
    assert.match(markup, /22,265 launches have been found/);
    assert.ok(!/class="note">22,265 launches/.test(markup), 'the backlog still leads the panel');
    assert.match(markup, /Index details/);
    assert.match(markup, /B20 index synced/);
  });
});
