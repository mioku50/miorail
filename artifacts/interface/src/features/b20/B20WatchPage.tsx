import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  B20EntryReviewCard,
  WalletBalancesCard,
  B20ExitCoverageCard,
  B20WatchScreen,
  ConsoleShell,
  EXIT_PROFILE_DEFAULTS_V1,
  b20ErrorCodeV1,
  b20UnavailableCopyV1,
  percentToBpsV1,
  usdcToAtomicV1,
  type ExitProfileV1,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  useConsoleTheme,
} from '@mioagent/ui';
import {
  useAddB20Watch,
  useB20BeginEntrySubmission,
  useB20EntryStatus,
  useB20ExitCheck,
  useB20OpportunitySimulate,
  useB20PrepareEntry,
  useB20RecordEntrySubmission,
  useB20Watch,
  useB20Watchlist,
  usePortfolio,
  useRemoveB20Watch,
  useStatus,
} from '@mioagent/api-client-react';
import { useSendCalls } from 'wagmi';

/** Canonical Base USDC — the one asset this family quotes in. The profile
 * identity the server computed is restated from it, so a mismatch is caught
 * rather than assumed. */
const B20_QUOTE_ASSET_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
import { isWalletRejectionError } from '@mioagent/wallet-actions';
import { useConsoleNav } from '../console/useConsoleNav';
import type { MarketObservationV1 } from '@mioagent/opportunity-rail/marketRails';

// ---------------------------------------------------------------------------
// T67F — the B20 tab.
//
// It reuses the console shell rather than being its own page: the header, the
// rails and the footer are the product's chrome, and a second layout would be a
// second product. The centre column is the only thing that differs.
//
// The sweep is EXPLICIT. It runs when someone presses "Check now", never on
// mount: each run is up to 25 on-chain reads against a metered endpoint, and a
// page that spends an operator's RPC budget for being opened is a page nobody
// should open.
// ---------------------------------------------------------------------------

/** Addresses the sweep can actually inspect, capped at the wire's limit.
 *
 * The native asset is excluded because it has no contract, and a spam token is
 * excluded because sweeping 25 airdropped tickers would spend the whole budget
 * before reaching anything the user holds on purpose. */
const SWEEP_LIMIT_V1 = 25;
const TRACKED_KEY_V1 = 'miorail.b20.tracked.v1';

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;

/** The tolerance the exit check probes with. Stated so the coverage card can
 * name it rather than implying a capacity measured against nothing. */
const EXIT_CHECK_TOLERANCE_BPS_V1 = 300;

/** Atomic units to a readable balance. Integer arithmetic: a float turns a
 * token with 18 decimals into scientific notation. */
function formatBalanceV1(atomic: string | null, decimals: number | null): string {
  if (atomic === null || decimals === null) return 'not read';
  const value = BigInt(atomic);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function shortAddress(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

/**
 * The exit check, in the shape the shared coverage projection reads.
 *
 * Deliberately an adapter and not a second computation: `exitCoverageV1` in
 * lib/opportunity-rail decides what coverage means, here and on the server.
 * Only the fields it actually reads are filled; the rest are the honest nulls
 * an exit check genuinely does not produce.
 */
function exitObservationForCoverageV1(
  tokenAddress: string,
  check: {
    exitCapacityAtomic: string | null;
    firstFailingAtomic: string | null;
    controlsBlockNumber?: string | null;
    checkedAt?: string | null;
  },
): MarketObservationV1 {
  const measuredAt = check.checkedAt ?? new Date().toISOString();
  return {
    tokenAddress,
    state: 'provisional',
    reasonCode: 'quoted_pre_entry',
    referenceQuoteAsset: B20_QUOTE_ASSET_V1,
    referencePositionAtomic: '0',
    profileIdentity: '',
    measurementVersion: 'b20-exit-check/v1',
    entryOutputAtomic: null,
    optimisticRoundTripBps: null,
    largestPassingSizeAtomic: check.exitCapacityAtomic,
    firstFailingSizeAtomic: check.firstFailingAtomic,
    capacityToleranceBps: EXIT_CHECK_TOLERANCE_BPS_V1,
    capacityStable: true,
    exitRouteFound: check.exitCapacityAtomic !== null,
    transfersPaused: null,
    transferPolicyState: null,
    controlsComplete: null,
    controlsBlockNumber: check.controlsBlockNumber ?? null,
    observationBlockNumber: check.controlsBlockNumber ?? '0',
    measuredAt,
    // An exit check is a live read; it is fresh for the same window a stored
    // observation gets, so a card cannot present a minutes-old check as
    // permanently current.
    staleAfter: new Date(Date.parse(measuredAt) + 30 * 60 * 1000).toISOString(),
  };
}

/** The balance the SWEEP read from the token itself, in atomic units. The
 * portfolio provider does not index B20, so this is the only honest source. */
function sweepBalanceAtomicV1(
  tokens: readonly { tokenAddress: string; balanceAtomic?: string | null }[],
  tokenAddress: string,
): string {
  const match = tokens.find((token) => token.tokenAddress.toLowerCase() === tokenAddress.toLowerCase());
  return match?.balanceAtomic ?? '0';
}

export function B20WatchPage() {
  const [, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  // T70 §8 — the shared section table. Portfolio is a primary surface now, not
  // a technical tab called "B20" hidden beside Routes.
  const consoleNav = useConsoleNav('portfolio');
  const status = useStatus();
  // T73-UI — the rails come from the server already ranked. Nothing below
  // re-sorts or re-derives them.
  const portfolio = usePortfolio(address);
  const sweep = useB20Watch();

  const gateOn = status.data?.productMigration?.b20ControlV1 === true;

  // T68B — the watchlist moved from localStorage to a table, because a sweep
  // that runs on a timer has no browser to ask. A list in localStorage is a
  // list nothing can watch.
  const watchlist = useB20Watchlist({ enabled: gateOn && Boolean(address) });
  const addWatch = useAddB20Watch();
  const removeWatch = useRemoveB20Watch();
  const tracked = useMemo(
    () => (watchlist.data?.tokens ?? []).map((entry) => entry.tokenAddress),
    [watchlist.data],
  );

  // Whatever the browser was already tracking is pushed up ONCE and then
  // forgotten locally. Dropping it silently would delete a list a user built by
  // hand, which is the one thing a storage change must not do.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !watchlist.isSuccess) return;
    seeded.current = true;
    let local: string[];
    try {
      const raw = globalThis.localStorage?.getItem(TRACKED_KEY_V1);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      local = Array.isArray(parsed) ? parsed.filter((entry): entry is string => ADDRESS_V1.test(String(entry))) : [];
    } catch {
      // A corrupt entry must not take the page down with it.
      local = [];
    }
    const known = new Set<string>(tracked);
    const missing = local.map((entry) => entry.toLowerCase()).filter((entry) => !known.has(entry));
    // Cleared only after the adds are issued, so a failed migration leaves the
    // local list where it was rather than losing it to a network error.
    for (const token of missing) addWatch.mutate({ tokenAddress: token });
    if (local.length > 0 && missing.length === 0) {
      try {
        globalThis.localStorage?.removeItem(TRACKED_KEY_V1);
      } catch {
        // Blocked storage keeps a stale copy. It is re-seeded and de-duplicated
        // by the server next time, so this is harmless.
      }
    }
  }, [watchlist.isSuccess, tracked, addWatch]);

  const held = useMemo(
    () =>
      (portfolio.data?.tokens ?? []).filter(
        (token) => /^0x[0-9a-fA-F]{40}$/.test(token.address) && token.possibleSpam !== true,
      ),
    [portfolio.data],
  );
  const sweepTokens = useMemo(() => {
    // Tracked addresses come first in the budget. They were added deliberately;
    // a provider-reported balance was not, and if the cap has to bite it must
    // bite the list the user did not curate.
    const ordered = [...tracked, ...held.map((token) => token.address.toLowerCase())];
    return [...new Set(ordered)].slice(0, SWEEP_LIMIT_V1);
  }, [tracked, held]);

  // T68 — the B20 holdings: the sweep says which tokens ARE B20, the portfolio
  // says how much of each is held. Joined here rather than server-side, because
  // the server never receives a balance and should not start.
  const holdings = useMemo(() => {
    const balances = new Map(held.map((token) => [token.address.toLowerCase(), token]));
    return (sweep.data?.tokens ?? [])
      .filter((token) => token.outcome === 'watched')
      .map((token) => {
        const balance = balances.get(token.tokenAddress.toLowerCase());
        const changes = token.watch?.status === 'compared' ? token.watch.changes : [];
        return {
          tokenAddress: token.tokenAddress,
          name: token.displayName,
          symbol: token.displaySymbol ?? balance?.symbol ?? null,
          // From the TOKEN, at the control block — not from a balance provider,
          // because none of them index B20. `null` means the read failed and
          // stays "not read"; it never becomes a zero.
          balanceLabel: formatBalanceV1(token.balanceAtomic ?? null, token.decimals ?? null),
          // Carried through for the exit card, whose capacity figures are in
          // atomic units of THIS token — not of the USDC that would buy it.
          decimals: token.decimals ?? null,
          // A missing price stays null all the way to the card, which renders
          // "no price source". A 0 here would reach a user as "worthless".
          usdLabel: balance?.usdValue ? `$${balance.usdValue}` : null,
          controls: token.controls ?? null,
          changeCount: changes.length,
          hasAcuteChange: changes.some((change) => change.severity === 'acute'),
          lastReadBlock: token.controls?.blockNumber ?? token.watch?.toBlock ?? null,
        };
      });
  }, [sweep.data, held]);

  const otherTokenCount = Math.max(0, held.length - holdings.length);

  // T68C — the exit check, for one token at a time. Each run is a dozen-odd
  // metered router calls, so it happens when a user asks and never on mount.
  const [exitToken, setExitToken] = useState<string | null>(null);
  // T68D — the profile is the user's. The defaults live here, in the UI, and
  // are not a server constant wearing a label.
  const [exitProfile, setExitProfile] = useState<ExitProfileV1>(EXIT_PROFILE_DEFAULTS_V1);
  const exitCheck = useB20ExitCheck();
  const exitSimulate = useB20OpportunitySimulate();
  const profileAtomic = useMemo(() => {
    const positionAtomic = usdcToAtomicV1(exitProfile.position);
    const maxRoundTripBps = percentToBpsV1(exitProfile.maxRoundTrip);
    const maxExitSlippageBps = percentToBpsV1(exitProfile.maxSlippage);
    return positionAtomic && maxRoundTripBps && maxExitSlippageBps
      ? { positionAtomic, maxRoundTripBps, maxExitSlippageBps }
      : null;
  }, [exitProfile]);
  const exitDecimals = useMemo(
    () => holdings.find((holding) => holding.tokenAddress === exitToken)?.decimals ?? null,
    [holdings, exitToken],
  );
  const runExitCheck = useCallback(
    (token: string) => {
      if (!profileAtomic) return;
      setExitToken(token);
      exitCheck.mutate({
        tokenAddress: token,
        positionAtomic: profileAtomic.positionAtomic,
        maxRoundTripBps: profileAtomic.maxRoundTripBps,
        maxSlippageBps: profileAtomic.maxExitSlippageBps,
      });
    },
    [exitCheck, profileAtomic],
  );
  const runSimulation = useCallback(
    (token: string) => {
      if (!profileAtomic) return;
      setExitToken(token);
      exitSimulate.mutate({
        tokenAddress: token,
        positionAtomic: profileAtomic.positionAtomic,
        maxRoundTripBps: profileAtomic.maxRoundTripBps,
        maxExitSlippageBps: profileAtomic.maxExitSlippageBps,
      });
    },
    [exitSimulate, profileAtomic],
  );
  // The simulation's answer wins when there is one: it is the only measurement
  // that can confirm, and a stale provisional beside a fresh confirmation would
  // be two answers to one question.
  const exitResult = useMemo(() => {
    if (exitSimulate.data) {
      return {
        status: exitSimulate.data.viability,
        reason: exitSimulate.data.rejectionReason,
        unmeasuredReason: exitSimulate.data.unmeasuredReason,
        coverage: exitSimulate.data.coverage,
        viableRouteConfirmed: exitSimulate.data.viableRouteConfirmed,
        bestRouteConfirmed: exitSimulate.data.bestRouteConfirmed,
        clearanceId: exitSimulate.data.clearanceId,
        expiresAt: exitSimulate.data.expiresAt,
        simulatedRoundTripBps: exitSimulate.data.simulatedRoundTripBps,
        simulationBlockNumber: exitSimulate.data.simulationBlockNumber,
        controlsBlockNumber: exitSimulate.data.controlsBlockNumber,
        checkedAt: exitSimulate.data.checkedAt,
        measurement: null,
        optimistic: false,
        roundTripCostBps: exitSimulate.data.simulatedRoundTripBps,
        exitCapacityAtomic: null,
        firstFailingAtomic: null,
        probeCount: 0,
        capacityInformative: false,
        referenceSizeAtomic: null,
        endpointDegraded: false,
      };
    }
    return exitCheck.data ?? null;
  }, [exitSimulate.data, exitCheck.data]);

  // --- T68F-B: the entry flow ------------------------------------------------
  //
  // Everything below is driven by the SERVER's projection. This component never
  // decides whether a wallet may be opened, never builds calldata and never
  // reports a result the wallet did not give it.
  const [planId, setPlanId] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const prepareEntry = useB20PrepareEntry();
  const beginSubmission = useB20BeginEntrySubmission();
  const recordSubmission = useB20RecordEntrySubmission();
  const sendCalls = useSendCalls();
  const entryStatus = useB20EntryStatus(planId, { enabled: Boolean(planId) });

  const entryReview = entryStatus.data?.review ?? prepareEntry.data?.review ?? null;
  const entryState = entryStatus.data?.status ?? prepareEntry.data?.review
    ? (entryStatus.data?.status ?? null)
    : null;

  const profileIdentityV1 = useCallback(
    () =>
      [
        B20_QUOTE_ASSET_V1,
        usdcToAtomicV1(exitProfile.position),
        percentToBpsV1(exitProfile.maxRoundTrip),
        percentToBpsV1(exitProfile.maxSlippage),
      ].join(':'),
    [exitProfile],
  );

  /** Qualified -> prepare -> Review. Nothing here opens a wallet. */
  const buildEntryPlan = useCallback(() => {
    const clearanceId = (exitResult as { clearanceId?: string | null } | null)?.clearanceId;
    if (!clearanceId) return;
    setWalletError(null);
    prepareEntry.mutate(
      {
        clearanceId,
        profileIdentity: profileIdentityV1(),
        // Stable for this clearance and profile, so a double click prepares
        // once rather than quoting the pool twice.
        requestId: `entry:${clearanceId}`,
      },
      { onSuccess: (data) => setPlanId(data.planId) },
    );
  }, [exitResult, prepareEntry, profileIdentityV1]);

  /**
   * The explicit user action. Opens the wallet, then reports what the WALLET
   * did — never a result, because a browser cannot know one.
   */
  const confirmInWallet = useCallback(async () => {
    if (!planId) return;
    setWalletError(null);
    const begun = await beginSubmission.mutateAsync({
      planId,
      profileIdentity: profileIdentityV1(),
      attemptRequestId: `attempt:${planId}`,
    });
    if (begun.outcome !== 'ready') {
      setWalletError(begun.detail);
      return;
    }
    try {
      // The payload comes from the server and is passed through untouched. No
      // calldata is built, rewritten or reordered in this browser.
      const result = await sendCalls.mutateAsync({
        calls: begun.payload.calls as never,
      });
      const batchId = typeof result === 'string' ? result : (result as { id?: string })?.id ?? null;
      if (!batchId) {
        // The wallet accepted it but named nothing we can ask about later.
        // Recorded as a failed request, never as a success.
        await recordSubmission.mutateAsync({
          planId,
          attemptId: begun.attemptId,
          result: 'wallet_failed',
          batchId: null,
        });
        return;
      }
      await recordSubmission.mutateAsync({
        planId,
        attemptId: begun.attemptId,
        result: 'submitted',
        batchId,
      });
    } catch (error) {
      // A rejected prompt is not a reverted transaction, and the two never
      // share a branch.
      await recordSubmission.mutateAsync({
        planId,
        attemptId: begun.attemptId,
        result: isWalletRejectionError(error) ? 'user_rejected' : 'wallet_failed',
        batchId: null,
      });
    }
  }, [planId, beginSubmission, profileIdentityV1, sendCalls, recordSubmission]);
  const exitUnavailable = (() => {
    if (!profileAtomic) {
      return 'That profile is not a size and two tolerances Miorail can act on. Whole USDC and a percent, please.';
    }
    const failure = exitSimulate.error ?? exitCheck.error;
    if (!failure) return null;
    const message = failure instanceof Error ? failure.message : String(failure);
    if (message.includes('position_below_minimum') || message.includes('position_above_maximum')) {
      return 'That position is outside the range this server will probe. A simulation spends the wallet’s real balance, so the ceiling is an operator’s choice.';
    }
    if (message.includes('b20_controls_unread')) {
      // Refused rather than assumed open: an exit check that skipped the
      // controls would clear a token whose transfers are paused.
      return 'This token’s controls have not been read yet. Press Check now first — an exit check that skipped them could clear a token that cannot be sold.';
    }
    if (message.includes('b20_rpc_unavailable') || message.includes('b20_rpc_no_answer')) {
      return 'The Base endpoint did not answer, so no quote was taken. This says nothing about the token.';
    }
    // Never the message: a router error can carry the endpoint, and the
    // endpoint can carry the key.
    return 'The exit check could not complete. Nothing here is a statement about the token.';
  })();

  // Watchlist failures are stated on the watchlist card, not in the sweep's
  // banner. A full list and an unreadable chain are different problems and only
  // one of them is fixed by pressing Check now again.
  const trackError = (() => {
    const error = addWatch.error ?? removeWatch.error ?? watchlist.error;
    if (!error) return null;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('b20_watchlist_full')) {
      return `This account already watches ${SWEEP_LIMIT_V1} tokens. Remove one to add another.`;
    }
    if (message.includes('b20_watchlist_unavailable')) {
      return 'Background watching is not set up on this server yet, so this list cannot be saved.';
    }
    // Never the message: a server error can carry an endpoint, and an endpoint
    // can carry a key.
    return 'The watchlist could not be reached. Nothing here is a statement about your tokens.';
  })();

  const unavailableReason = !address
    ? 'Connect your wallet to see what the tokens you hold have done.'
    : !gateOn
      ? 'B20 control inspection is off on this server, so nothing was read. This is not a statement about your tokens.'
      : portfolio.error
        ? 'Your balances could not be read, so there is no list of tokens to check.'
        : sweep.error
          ? // The server distinguishes "nothing is configured" from "the endpoint
            // went quiet", and this is where that distinction reaches a user —
            // one of them is worth retrying and the other never will be.
            (b20UnavailableCopyV1({
              gateEnabled: true,
              skipReason: null,
              errorCode: b20ErrorCodeV1(sweep.error),
            }) ?? 'The sweep could not complete. Nothing here is a statement about your tokens.')
          : held.length === 0 && portfolio.data
            ? 'No ERC-20 balances were found for this wallet.'
            : null;

  // T73-UI §1/§3 — the same node in both slots: `right` is the desktop column
  // and `railFold` is where the shell moves it below the main content under
  // 1180px, which is §3's mobile placement with no second layout.

  // §5 — the wallet's own coverage, for the token whose exit was just checked.
  // It is computed in this browser because the server never receives a balance:
  // position size is the one input Miorail deliberately never holds.
  const coverageHolding = holdings.find((holding) => holding.tokenAddress === exitToken) ?? null;
  const coverageObservation =
    exitToken && exitResult && (exitResult as { exitCapacityAtomic?: string | null }).exitCapacityAtomic
      ? exitObservationForCoverageV1(exitToken, exitResult as never)
      : null;

  // The wallet's ordinary balances. Deliberately ABOVE the B20 rails: the
  // first question on a page called Portfolio is "what do I hold", and until
  // now this surface answered only "what have my B20 controls done".
  const balancesModel = {
    loading: portfolio.isPending && Boolean(address),
    unavailableReason: !address
      ? 'Connect your wallet to see your balances.'
      : portfolio.error
        // Never the provider's message: it can carry an endpoint, and an
        // endpoint can carry a key.
        ? 'Your balances could not be read. This is not a statement about what you hold.'
        : null,
    rows: portfolio.data?.tokens ?? [],
    note:
      portfolio.data && (portfolio.data.tokens ?? []).length > 0
        ? 'Balances come from a token provider; B20 holdings are read from the tokens themselves below.'
        : null,
  };

  const marketRail = (
    <>
      <WalletBalancesCard {...balancesModel} />
      {coverageHolding && coverageObservation && (
        <B20ExitCoverageCard
          tokenAddress={coverageHolding.tokenAddress}
          symbol={coverageHolding.symbol ?? coverageHolding.tokenAddress.slice(0, 8)}
          decimals={coverageHolding.decimals}
          positionAtomic={sweepBalanceAtomicV1(sweep.data?.tokens ?? [], coverageHolding.tokenAddress)}
          observation={coverageObservation}
          now={new Date()}
        />
      )}
    </>
  );

  return (
    <ConsoleShell
      header={{
        crumb: ['Portfolio', 'Control watch'],
        nav: consoleNav.header,
        onNavigate: consoleNav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddress(address),
      }}
      left={{
        nav: consoleNav.rail,
        sessions: [],
        sessionCount: '0',
        proofs: [],
        proofCount: '0',
        // T70 §2 — Budget & payments is on Settings now, for every surface.
        onOpenSettings: () => consoleNav.navigate('settings'),
      }}
      footer={{
        adaptersLabel: '—',
        sourcesLabel: String(sweep.data?.tokens.length ?? 0),
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={marketRail}
      railFold={marketRail}
      theme={theme}
      onThemeChange={setTheme}
      // The B20 tab has no sessions and no proof list of its own: starting a
      // goal or opening a proof belongs to the surfaces that own them, so those
      // handlers navigate there rather than doing nothing here.
      onNewGoal={() => consoleNav.navigate('routes')}
      onSelectSession={() => consoleNav.navigate('routes')}
      onSelectProof={() => consoleNav.navigate('proofs')}
    >
      {entryReview && entryState && (
        <B20EntryReviewCard
          review={entryReview}
          status={entryState}
          now={new Date()}
          busy={beginSubmission.isPending || sendCalls.isPending || recordSubmission.isPending}
          // Passed only when the whole path exists. The card renders NO control
          // when this is absent, rather than a disabled one.
          onConfirm={entryReview.executionAvailable ? confirmInWallet : undefined}
          onRefresh={() => entryStatus.refetch()}
          onBack={() => {
            setPlanId(null);
          }}
        />
      )}
      {walletError && <p className="note warn">{walletError}</p>}
      <B20WatchScreen
        tokens={sweep.data?.tokens ?? []}
        holdings={holdings}
        otherTokenCount={otherTokenCount}
        trackedTokens={watchlist.data?.tokens ?? []}
        trackRemaining={watchlist.data?.remaining ?? null}
        trackError={trackError}
        onTrackToken={(token) => addWatch.mutate({ tokenAddress: token })}
        onUntrackToken={(token) => removeWatch.mutate({ tokenAddress: token })}
        // Swapping a held B20 token is the Routes flow's job, not a second
        // execution path. The tab hands the goal over rather than growing one.
        onOpenToken={(token) => navigate(`/?goal=${encodeURIComponent(`swap ${token} to USDC`)}`)}
        exit={{
          tokenAddress: exitToken,
          check: exitResult as never,
          profile: exitProfile,
          onProfileChange: setExitProfile,
          positionLabel: `${exitProfile.position} USDC`,
          slippagePercentLabel: `${exitProfile.maxSlippage}%`,
          // Atomic units of the TOKEN being sold, so the decimals are the
          // token's — not USDC's. Unknown decimals render the raw amount
          // rather than a number scaled by a guess.
          formatTokenAmount: (atomic) => formatBalanceV1(atomic, exitDecimals),
          loading: exitCheck.isPending,
          simulating: exitSimulate.isPending,
          unavailableReason: exitUnavailable,
          onCheck: runExitCheck,
          onSimulate: runSimulation,
          // T68F-B — wired. The card only offers this when the clearance is
          // live and qualified; the gate lives in `entryPlanAvailableV1`.
          onBuildEntryPlan: buildEntryPlan,
        }}
        notChecked={sweep.data?.notChecked ?? []}
        checkedAt={sweep.data?.checkedAt ?? null}
        loading={sweep.isPending}
        unavailableReason={unavailableReason}
        heldCount={held.length}
        onSweep={() => {
          if (sweepTokens.length > 0) sweep.mutate({ tokens: sweepTokens });
        }}
      />
    </ConsoleShell>
  );
}
