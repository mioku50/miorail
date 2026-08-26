import { useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useAccount } from 'wagmi';
import {
  B20ExitCapacityLeadersCard,
  B20MeasuredMoversCard,
  ConsoleShell,
  OpportunitiesScreen,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainUnavailableReasonV1,
  chainLabelV1,
  consoleHomeSectionV1,
  consoleSectionPathV1,
  discoverFocusHrefV1,
  parseDiscoverFocusV1,
  GOAL_HANDOFF_KEY_V1,
  discoverFailureCopyV1,
  opportunityCardViewV1,
  useConsoleTheme,
  consoleIndexStatusV1,
  consoleOperationalLabelV1,
  consolePipelineNoticeLeadsV1,
  consolePipelineProgressV1,
  type ConsolePipelineStateV1,
  type OpportunityFilterV1,
  type B20ConsoleScopeViewV1,
  type B20ProjectFilterV1,
  type OpportunityStandingFilterV1,
} from '@mioagent/ui';
import {
  useB20ConsoleAsk,
  useB20CopilotAsk,
  useB20LaunchContext,
  useB20MarketRails,
  useB20Opportunities,
  useB20Opportunity,
  useB20PublicContext,
  useStatus,
} from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';
import { discoverFocusStateV1 } from './discoverFocusState';

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
  // The focused token lives in the URL, so a refresh and a Back press both
  // restore it. Read through wouter's own search hook rather than
  // `window.location.search`: the latter does not re-render when the same page
  // navigates, which is exactly what opening a token from the rail does.
  const search = useSearch();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('opportunities');

  const [filter, setFilter] = useState<OpportunityFilterV1>('all');
  const [standingFilter, setStandingFilter] = useState<OpportunityStandingFilterV1>('all');
  const [projectFilter, setProjectFilter] = useState<B20ProjectFilterV1>('all');
  const [freshOnly, setFreshOnly] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const [copilotToken, setCopilotToken] = useState<string | null>(null);
  const [consoleScope, setConsoleScope] = useState<B20ConsoleScopeViewV1>('explore');
  const [consoleTokens, setConsoleTokens] = useState<readonly string[]>([]);
  // Null until a reader opens one. The query is disabled while it is null, so
  // the feed costs nothing extra to render.
  const [contextToken, setContextToken] = useState<string | null>(null);

  const discoverOn = status.data?.productMigration?.b20ControlV1 === true;
  const marketRails = useB20MarketRails({ enabled: discoverOn });
  const feed = useB20Opportunities(
    // The verdict section is a SERVER filter. Grouping only what one page
    // returned would have put the 70 launches that were bought and could not be
    // sold behind roughly 46 pages of 25, which is the same as not having them.
    {
      state: filter,
      standing: standingFilter,
      freshness: freshOnly ? 'fresh' : 'all',
      // A different axis from what was measured, and a SERVER filter for the
      // same reason the standing one is: a verified claim is rare enough that
      // grouping one page would be the same as not having the filter.
      project: projectFilter,
    },
    { enabled: discoverOn },
  );
  // ── The focused token ────────────────────────────────────────────────────
  // Validated in `parseDiscoverFocusV1`, because `?token=` is text a stranger
  // can write. An address that is not one focuses nothing at all.
  const focus = useMemo(() => parseDiscoverFocusV1(search), [search]);
  const focusedInFeed = useMemo(
    () =>
      (feed.data?.cards ?? []).find(
        // The WIRE card, where the address lives on the launch. The view model
        // built from it is the one with a flat `tokenAddress`.
        (card) => card.launch.tokenAddress.toLowerCase() === focus.tokenAddress,
      ) ?? null,
    [feed.data, focus.tokenAddress],
  );
  // Only when the feed's own page does not already hold it. A token on page one
  // costs no extra request; a token on page forty is read by address.
  const focusDetail = useB20Opportunity(focus.tokenAddress, {
    enabled: discoverOn && focus.tokenAddress !== null && focusedInFeed === null,
  });
  const focusCard = useMemo(() => {
    if (focus.tokenAddress === null) return null;
    const card = focusedInFeed ?? focusDetail.data?.card ?? null;
    return card ? opportunityCardViewV1(card) : null;
  }, [focus.tokenAddress, focusedInFeed, focusDetail.data]);

  // Unverified public context. A mutation, so it runs when a reader presses
  // the control and never because a card rendered.
  const [publicContextToken, setPublicContextToken] = useState<string | null>(null);
  const publicContext = useB20PublicContext();

  const copilot = useB20CopilotAsk();
  const launchContext = useB20LaunchContext(contextToken);
  const b20Console = useB20ConsoleAsk({
    // The scope the SERVER answered in wins. An address in the question moves
    // the answer to that token, and leaving the tab where it was would label
    // the answer wrongly.
    onSuccess: (answer) => setConsoleScope(answer.scope),
  });

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
    // A rail row opens THIS token's measurement, and stays on Discover. It used
    // to navigate to Portfolio, which owns the wallet-bound exit check and no
    // Discover measurement at all — and which has never read `?token=`, so the
    // address was dropped on the way as well.
    onOpenToken: (token: string) =>
      navigate(discoverFocusHrefV1({ sectionPath: consoleSectionPathV1('opportunities'), tokenAddress: token })),
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
        crumb: ['Discover B20'],
        nav: nav.header,
        onNavigate: nav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        chainUnavailableReason: chainUnavailableReasonV1(status.data ?? null),
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
      onSelectProof={() => navigate(consoleSectionPathV1('activity'))}
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
        // Index coverage, which is a different question from measurement
        // coverage and the one that is finished. Both counts come straight off
        // the pipeline facts the API already sends.
        indexStatus={
          pipeline
            ? consoleIndexStatusV1({
                state: pipeline.state as ConsolePipelineStateV1,
                facts: {
                  canonicalLaunchCount: pipeline.facts.canonicalLaunchCount,
                  launchesAwaitingMeasurement: pipeline.facts.launchesAwaitingMeasurement,
                  observationCount: pipeline.facts.observationCount,
                  ingestionCursorBlock: pipeline.facts.ingestionCursorBlock,
                  confirmedHead: pipeline.facts.confirmedHead,
                },
              })
            : null
        }
        pipelineNoticeLeads={consolePipelineNoticeLeadsV1(
          (pipeline?.state as ConsolePipelineStateV1 | undefined) ?? null,
        )}
        feedRenderable={discoverOn && (feed.isPending || home.feedRenderable)}
        cards={cards}
        filter={filter}
        standingFilter={standingFilter}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        freshOnly={freshOnly}
        loading={feed.isPending && discoverOn}
        onFilterChange={setFilter}
        onStandingFilterChange={setStandingFilter}
        onFreshOnlyChange={setFreshOnly}
        // The card's own action, which is always wallet-bound: "Check against
        // my wallet", "Try another profile" and "Refresh measurement" all need
        // the exit profile and the wallet, and both live on Portfolio — which
        // now reads this token rather than dropping it.
        onOpenToken={(token) =>
          navigate(
            // The same builder the measurement link uses, so the parameter
            // Portfolio parses cannot drift from the one Discover writes.
            discoverFocusHrefV1({
              sectionPath: consoleSectionPathV1('portfolio'),
              tokenAddress: token,
              // Portfolio has one thing to do with a token, so it names no view.
              view: null,
            }),
          )
        }
        // Reading what was measured needs no wallet, so it never leaves here.
        onOpenMeasurement={(token) =>
          navigate(discoverFocusHrefV1({ sectionPath: consoleSectionPathV1('opportunities'), tokenAddress: token }))
        }
        onRefresh={() => void feed.refetch()}
        focus={{
          tokenAddress: focus.tokenAddress,
          card: focusCard,
          ...discoverFocusStateV1({
            tokenAddress: focus.tokenAddress,
            discoverOn,
            inFeed: focusedInFeed !== null,
            detailPending: focusDetail.isPending,
            detailError: focusDetail.error?.message ?? null,
            hasCard: focusCard !== null,
          }),
          // Back to the whole feed. A plain navigation rather than a state
          // reset, so Back and Forward keep working through the selection.
          onClear: () => navigate(consoleSectionPathV1('opportunities')),
        }}
        publicContext={{
          tokenAddress: publicContextToken,
          loading: publicContext.isPending,
          context: (publicContext.data as never) ?? null,
          // Never the server's message: it can name a provider. The card
          // says this is about the request, not about the token.
          error: publicContext.error
            ? 'Miorail could not complete a public search for this token. That is about the search, not about the token.'
            : null,
          onLook: (token: string, domain?: string) => {
            setPublicContextToken(token);
            publicContext.mutate({ tokenAddress: token, ...(domain ? { domain } : {}) });
          },
        }}
        launchContext={{
          tokenAddress: contextToken,
          loading: launchContext.isPending && contextToken !== null,
          context: launchContext.data ?? null,
          error: launchContext.error?.message ?? null,
          onOpen: setContextToken,
        }}
        console={{
          scope: consoleScope,
          tokenAddresses: consoleTokens,
          loading: b20Console.isPending,
          answer: b20Console.data ?? null,
          error: b20Console.error?.message ?? null,
          onScopeChange: setConsoleScope,
          onTokensChange: setConsoleTokens,
          onAsk: (input) => {
            b20Console.mutate({
              schemaVersion: 'b20-console-ask/v1',
              scope: input.scope,
              question: input.question,
              // Omitted rather than sent empty: the schema treats an absent
              // list and an empty one the same, and an empty array on the wire
              // reads as "the reader chose none" rather than "none chosen".
              ...(input.tokenAddresses.length > 0 ? { tokenAddresses: [...input.tokenAddresses] } : {}),
            });
          },
        }}
        copilot={{
          tokenAddress: copilotToken,
          loading: copilot.isPending,
          answer:
            copilot.data?.subject.tokenAddress === copilotToken
              ? copilot.data
              : null,
          error: copilot.error?.message ?? null,
          onAsk: (input) => {
            setCopilotToken(input.tokenAddress);
            copilot.mutate({ schemaVersion: 'b20-copilot-ask/v1', ...input });
          },
          onOpenRoutes: (goal) => {
            try {
              window.sessionStorage.setItem(GOAL_HANDOFF_KEY_V1, goal);
            } catch {
              // The URL still carries the goal. Without the one-shot token the
              // console fills it in and waits for an explicit Compare click.
            }
            navigate(`${consoleSectionPathV1('routes')}?goal=${encodeURIComponent(goal)}`);
          },
        }}
      />
    </ConsoleShell>
  );
}
