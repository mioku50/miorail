import { useRoute } from 'wouter';
import { useAccount, useSendCalls } from 'wagmi';
import {
  BorrowReviewScreen,
  ConsoleShell,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  chainUnavailableReasonV1,
  useBorrowReviewConsoleV1,
  useConsoleTheme,
} from '@mioagent/ui';
import { useStatus } from '@mioagent/api-client-react';
import { builderCodeForSurfaceV1, builderCodeToDataSuffix } from '@mioagent/wallet-actions';

import { useConsoleNav } from '../console/useConsoleNav';

/**
 * ERC-8021 attribution for this surface.
 *
 * A batch sent without a `dataSuffix` loses Builder Code attribution SILENTLY —
 * no error, no warning, just a transaction nobody can attribute to the app that
 * produced it. A repo-wide test holds every `useSendCalls` site to this.
 */
const BORROW_BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(
  builderCodeForSurfaceV1({
    VITE_BASE_BUILDER_CODE: import.meta.env?.VITE_BASE_BUILDER_CODE as string | undefined,
    VITE_BUILDER_CODE: import.meta.env?.VITE_BUILDER_CODE as string | undefined,
  }),
);

// ---------------------------------------------------------------------------
// The borrow review, on the web.
//
// Everything a reader is told lives in `BorrowReviewScreen`, and every read and
// refusal sentence in `useBorrowReviewConsoleV1`, so this file is the shell,
// the navigation and the wallet — the three things that genuinely differ
// between here and Base App.
//
// Opening this page MEASURES. The link carries the question and no number, so
// the market is read again, the venue writes the calldata again, and the batch
// is executed against current state before anything appears. A borrow review
// that showed figures from the conversation that produced the link would be
// showing a health factor that has since moved.
// ---------------------------------------------------------------------------

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function BorrowReviewPage() {
  const [, params] = useRoute('/borrow/:draft');
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('market');
  const sendCalls = useSendCalls();

  const reviewConsole = useBorrowReviewConsoleV1({
    draft: params?.draft ?? null,
    sendCalls: async ({ calls }) => {
      const result = await sendCalls.mutateAsync({
        calls: calls as never,
        chainId: 8453,
        // Optional, so a wallet that does not understand the capability still
        // sends the batch rather than refusing it.
        capabilities: BORROW_BUILDER_SUFFIX_V1
          ? { dataSuffix: { value: BORROW_BUILDER_SUFFIX_V1, optional: true } }
          : undefined,
      });
      return typeof result === 'string' ? result : ((result as { id?: string })?.id ?? null);
    },
  });

  return (
    <ConsoleShell
      header={{
        crumb: ['Stocks', 'Borrow'],
        nav: nav.header,
        onNavigate: nav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        chainUnavailableReason: chainUnavailableReasonV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddressV1(address),
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
        sourcesLabel: '1',
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={null}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => nav.navigate('routes')}
      onSelectSession={() => nav.navigate('routes')}
      onSelectProof={() => nav.navigate('activity')}
    >
      <BorrowReviewScreen model={reviewConsole.model} />
    </ConsoleShell>
  );
}
