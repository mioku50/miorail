import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, RotateCcw } from 'lucide-react';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import { expectedChainId } from '../../lib/chain';
import {
  PaidActionError,
  type PaidActionResult,
  type PaidActionState,
  paidActionButtonLabel,
  paidActionCopy,
  runX402PaidFetch,
} from '../../lib/x402PaidFetch';

export interface PaidActionButtonProps {
  label?: string;
  route: string;
  actionType: string;
  costLabel: string;
  category: 'tools' | 'inference';
  disabled?: boolean;
  onSuccess?: (result: PaidActionResult) => void | Promise<void>;
  onFailure?: (error: PaidActionError) => void;
}

const busyStates: PaidActionState[] = [
  'preparing_payment',
  'awaiting_wallet_confirmation',
  'settling_payment',
  'running_action',
];

export function PaidActionButton({
  label = 'Paid action',
  route,
  actionType,
  costLabel,
  category,
  disabled,
  onSuccess,
  onFailure,
}: PaidActionButtonProps) {
  const [state, setState] = useState<PaidActionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const { isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChain } = useSwitchChain();

  const isBusy = busyStates.includes(state);
  const isWrongChain = isConnected && chainId !== expectedChainId;
  const buttonLabel = useMemo(() => {
    if (!isConnected) return 'Connect wallet first';
    if (isWrongChain) return 'Switch to Base';
    return paidActionButtonLabel(state, costLabel);
  }, [costLabel, isConnected, isWrongChain, state]);

  const Icon =
    state === 'succeeded' ? CheckCircle2 :
    state === 'rejected' || state === 'failed' || state === 'settlement_failed' || state === 'insufficient_funds' || state === 'unsupported_wallet' ? RotateCcw :
    isBusy ? Loader2 :
    isWrongChain ? AlertTriangle :
    CreditCard;

  async function handleClick() {
    if (!isConnected) {
      setState('unsupported_wallet');
      setError('Connect wallet first');
      return;
    }
    if (isWrongChain) {
      switchChain?.({ chainId: expectedChainId });
      return;
    }
    setError(null);
    try {
      const result = await runX402PaidFetch({
        route,
        walletClient,
        expectedChainId,
        onState: setState,
      });
      await onSuccess?.(result);
    } catch (rawError) {
      const paidError = rawError instanceof PaidActionError
        ? rawError
        : new PaidActionError('failed', rawError instanceof Error ? rawError.message : 'Payment failed');
      setState(paidError.state);
      setError(paidError.message);
      onFailure?.(paidError);
    }
  }

  const variant =
    state === 'succeeded' ? 'border-ok/25 bg-ok-soft text-ok' :
    state === 'rejected' || state === 'failed' || state === 'settlement_failed' || state === 'insufficient_funds' || state === 'unsupported_wallet'
      ? 'border-risk/25 bg-warn-soft text-risk'
      : 'border-accent/20 bg-accent text-white hover:bg-accent-2';

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || isBusy}
        className={`inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-[13px] font-sans font-semibold transition-colors disabled:cursor-wait disabled:opacity-70 ${variant}`}
        title={`${label}: ${actionType} (${category})`}
      >
        <Icon className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
        <span className="truncate">{buttonLabel}</span>
      </button>
      <div className="flex items-start justify-between gap-3 text-[11px]">
        <span className="text-ink-3">{error || paidActionCopy(state)}</span>
        <span className="shrink-0 font-mono text-ink-3">{category}</span>
      </div>
    </div>
  );
}
