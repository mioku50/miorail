import { useMemo } from 'react';
import { useLocation } from 'wouter';
import { useAccount } from 'wagmi';
import {
  B20WatchScreen,
  ConsoleShell,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  useConsoleTheme,
} from '@mioagent/ui';
import { useB20Watch, usePortfolio, useStatus } from '@mioagent/api-client-react';

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

  const held = useMemo(
    () =>
      (portfolio.data?.tokens ?? []).filter(
        (token) => /^0x[0-9a-fA-F]{40}$/.test(token.address) && token.possibleSpam !== true,
      ),
    [portfolio.data],
  );
  const sweepTokens = useMemo(
    () => held.slice(0, SWEEP_LIMIT_V1).map((token) => token.address.toLowerCase()),
    [held],
  );

  const unavailableReason = !address
    ? 'Connect your wallet to see what the tokens you hold have done.'
    : !gateOn
      ? 'B20 control inspection is off on this server, so nothing was read. This is not a statement about your tokens.'
      : portfolio.error
        ? 'Your balances could not be read, so there is no list of tokens to check.'
        : sweep.error
          ? 'The sweep could not complete. Nothing here is a statement about your tokens.'
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
      right={null}
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
