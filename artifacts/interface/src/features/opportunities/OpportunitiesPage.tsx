import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  B20ExitCapacityLeadersCard,
  B20MeasuredMoversCard,
  ConsoleShell,
  OpportunitiesScreen,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  consoleHomeSectionV1,
  consoleSectionPathV1,
  discoverFailureCopyV1,
  opportunityCardViewV1,
  useConsoleTheme,
  consoleOperationalLabelV1,
  consolePipelineProgressV1,
  type ConsolePipelineStateV1,
  type OpportunityFilterV1,
} from '@mioagent/ui';
import { useB20MarketRails, useB20Opportunities, useStatus } from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';

// ---------------------------------------------------------------------------
// T70 §1 — the product's home.
//
// This page reads the Discover feed and draws cards. It holds no clearance,
// prepares no plan and opens no wallet: "Check against my wallet" hands the
// token address to the Portfolio surface, where the sequential simulation that
// already exists is the only thing that can qualify anything.
//
// That boundary is the reason this page is as thin as it is. A background
// observation is display context. If Opportunities could shorten the path to a
// signature, `provisional` would become the thing users act on, and provisional
// is by construction a measurement taken before the entry moved the pool.
// ---------------------------------------------------------------------------

function shortAddress(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function OpportunitiesPage() {
  const [, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('opportunities');

  const [filter, setFilter] = useState<OpportunityFilterV1>('all');
  const [freshOnly, setFreshOnly] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);

  const discoverOn = status.data?.productMigration?.b20ControlV1 === true;
  const marketRails = useB20MarketRails({ enabled: discoverOn });
  const feed = useB20Opportunities(
    { state: filter, freshness: freshOnly ? 'fresh' : 'all' },
    { enabled: discoverOn },
  );

  // A transport failure is NOT an empty feed. The pipeline is unknown, and
  // `consoleHomeSectionV1` turns that into the unreachable sentence rather than
  // into "no opportunities".
  const pipeline = feed.data?.pipeline ?? null;
  const home = useMemo(
    () =>
      consoleHomeSectionV1({
        pipeline: pipeline
          ? { state: pipeline.state as ConsolePipelineStateV1, message: pipeline.message }
          : null,
        observationCount: feed.data?.cards.length ?? 0,
        walletConnected: Boolean(address),
      }),
    [pipeline, feed.data, address],
  );

  const cards = useMemo(
    () => (feed.data?.cards ?? []).map((card) => opportunityCardViewV1(card)),
    [feed.data],
  );

  // While the feed is still in flight the pipeline is genuinely unknown, so the
  // page says it is loading rather than showing the unreachable sentence for a
  // beat and then replacing it.
  const pipelineNotice = !discoverOn
    ? 'B20 Discover is off on this server, so no launches are being read. Route comparison and your portfolio are unaffected.'
    : feed.isPending
      ? null
      : // A failed request and a quiet pipeline are different problems, and
        // only one of them is worth pressing "Check again" for.
        feed.error
        ? discoverFailureCopyV1(feed.error)
        : home.notice;

  // The measured market rails. They belong here rather than on B20: leaders and
  // movers are statements about every token Miorail has measured, not about the
  // ones this wallet happens to hold — and this is the surface a user scans
  // when looking for something new. They also give Discover something true to
  // show on days when no launch clears the exit policy.
  const railModel = {
    loading: marketRails.isPending && discoverOn,
    unavailableReason: !discoverOn
      ? 'B20 Discover is off on this server, so no market measurements were read.'
      : marketRails.error
        ? 'The measured market rails could not be read. Nothing here is a statement about any token.'
        : null,
    leaders: marketRails.data?.capacityLeaders ?? [],
    movers: marketRails.data?.movers ?? [],
    collectingHistory: marketRails.data?.collectingHistory === true,
    toleranceBps: marketRails.data?.toleranceBps ?? 300,
    moveLabel: marketRails.data?.moveLabel ?? '',
    moveNote: marketRails.data?.moveNote ?? '',
    now: new Date(),
    expanded: railExpanded,
    onToggleExpanded: () => setRailExpanded((open) => !open),
    // Opening a token from the rail goes where that token can be acted on.
    onOpenToken: (token: string) =>
      navigate(`${consoleSectionPathV1('portfolio')}?token=${encodeURIComponent(token)}`),
  };

  const marketRail = (
    <>
      <B20ExitCapacityLeadersCard {...railModel} />
      <B20MeasuredMoversCard {...railModel} />
    </>
  );

  return (
    <ConsoleShell
      header={{
        crumb: ['Discover'],
        nav: nav.header,
        onNavigate: nav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddress(address),
      }}
      left={{
        nav: nav.rail,
        sessions: [],
        sessionCount: '0',
        proofs: [],
        proofCount: '0',
        onOpenSettings: () => nav.navigate('settings'),
      }}
      footer={{
        adaptersLabel: '—',
        sourcesLabel: String(feed.data?.cards.length ?? 0),
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={marketRail}
      railFold={marketRail}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('proofs'))}
    >
      <OpportunitiesScreen
        pipelineNotice={pipelineNotice}
        pipelineState={(pipeline?.state as ConsolePipelineStateV1 | undefined) ?? null}
        // §9 — stated, never inferred from how many cards came back.
        pipelineLabel={consoleOperationalLabelV1((pipeline?.state as ConsolePipelineStateV1 | undefined) ?? null)}
        pipelineProgress={
          pipeline
            ? consolePipelineProgressV1({
                ingestionCursorBlock: pipeline.facts.ingestionCursorBlock,
                confirmedHead: pipeline.facts.confirmedHead,
                blocksBehind: pipeline.blocksBehind,
              })
            : null
        }
        feedRenderable={discoverOn && (feed.isPending || home.feedRenderable)}
        cards={cards}
        filter={filter}
        freshOnly={freshOnly}
        loading={feed.isPending && discoverOn}
        onFilterChange={setFilter}
        onFreshOnlyChange={setFreshOnly}
        // The handoff. Portfolio owns the wallet-bound exit check, the
        // simulation and the clearance; Discover owns none of them.
        onOpenToken={(token) => navigate(`${consoleSectionPathV1('portfolio')}?token=${encodeURIComponent(token)}`)}
        onRefresh={() => void feed.refetch()}
      />
    </ConsoleShell>
  );
}
