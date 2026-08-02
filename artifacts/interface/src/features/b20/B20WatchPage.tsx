import { useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  B20WatchScreen,
  ConsoleRightRail,
  ConsoleShell,
  b20ErrorCodeV1,
  b20UnavailableCopyV1,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  useConsoleTheme,
} from '@mioagent/ui';
import {
  useAddB20Watch,
  useB20Watch,
  useB20Watchlist,
  usePortfolio,
  useRemoveB20Watch,
  useStatus,
} from '@mioagent/api-client-react';

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

export function B20WatchPage() {
  const [, navigate] = useLocation();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
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

  return (
    <ConsoleShell
      header={{
        crumb: ['B20', 'Control watch'],
        tabs: [
          { id: 'routes', label: 'Routes', active: false, onSelect: () => navigate('/') },
          { id: 'b20', label: 'B20', active: true, onSelect: () => navigate('/b20') },
          { id: 'proofs', label: 'Proofs', active: false, onSelect: () => navigate('/plan/history') },
        ],
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddress(address),
      }}
      left={{
        sessions: [],
        sessionCount: '0',
        proofs: [],
        proofCount: '0',
        limits: null,
        limitsUnavailableReason: 'Budget & payments lives on the Routes tab.',
        adapters: { rows: [], summary: '—' },
      }}
      footer={{
        adaptersLabel: '—',
        sourcesLabel: String(sweep.data?.tokens.length ?? 0),
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={
        <ConsoleRightRail
          // No price and no depth panel here: this tab is about controls, and
          // a price chart beside a control card invites the reading the whole
          // surface refuses — that a control state predicts a price.
          price={null}
          priceUnavailableReason="Price is on the Routes tab. This rail reports what was read, not what it is worth."
          depth={null}
          depthUnavailableReason="Depth belongs to a route comparison, not to a control read."
          evidenceFeed={(sweep.data?.tokens ?? []).slice(0, 8).map((token, index) => ({
            id: `${token.tokenAddress}-${index}`,
            time: token.controls?.blockNumber ? `block ${token.controls.blockNumber}` : '—',
            source: token.displaySymbol ?? token.tokenAddress.slice(0, 10),
            text:
              token.outcome === 'watched'
                ? `${token.watch?.status === 'compared' ? token.watch.changes.length : 0} change(s)`
                : token.outcome,
            available: token.outcome === 'watched',
          }))}
          spend={null}
          freshness={[
            { label: 'B20 tokens held', value: String(holdings.length) },
            { label: 'Other tokens', value: String(otherTokenCount) },
            {
              label: 'Last checked',
              value: sweep.data?.checkedAt ? sweep.data.checkedAt.slice(11, 19) : 'never',
              tone: sweep.data ? undefined : 'off',
            },
            {
              label: 'Not reached',
              value: String(sweep.data?.notChecked.length ?? 0),
              tone: (sweep.data?.notChecked.length ?? 0) > 0 ? 'off' : undefined,
            },
          ]}
        />
      }
      railFold={null}
      theme={theme}
      onThemeChange={setTheme}
      // The B20 tab has no sessions and no proof list of its own: starting a
      // goal or opening a proof belongs to the surfaces that own them, so those
      // handlers navigate there rather than doing nothing here.
      onNewGoal={() => navigate('/')}
      onSelectSession={() => navigate('/')}
      onSelectProof={() => navigate('/plan/history')}
    >
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
