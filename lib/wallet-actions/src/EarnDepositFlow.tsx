// T62.1 §2 — the shared Earn deposit execution flow, used IDENTICALLY by the
// web (/plan) and miniapp surfaces so there is one flow, not two. It drives:
//   Earn Route Card → select candidate → prepare (server owns calldata) →
//   unsigned review (expiry, exact approval, protocol contract, calls) →
//   BlueprintSubmitButton (goal='earn' → server approve → Base Account
//   wallet_sendCalls → submission record) → Route Proof status.
// The client NEVER supplies calldata, and it reuses the ONE
// BlueprintSubmitButton / useSubmitApprovedBlueprint wallet implementation.

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { EarnRouteCardView, deriveEarnRouteCardViewV1 } from '@mioagent/ui';
import { usePrepareEarnDeposit } from '@mioagent/api-client-react';
import type { EarnCompareResponseV1, EarnPrepareResponseV1 } from '@mioagent/api-spec';
import { BlueprintSubmitButton } from './BlueprintSubmitButton';
import type { BlueprintSubmitStatus } from './useSubmitApprovedBlueprint';

type ComparedEarnCard = Extract<EarnCompareResponseV1, { outcome: 'compared' }>['routeCard'];
type PreparedEarn = Extract<EarnPrepareResponseV1, { outcome: 'prepared' }>;

export interface EarnDepositFlowProps {
  /** The persisted earn Route Run the server returned from /earn/compare. */
  routeRunId: string;
  routeCard: ComparedEarnCard;
  /** Public ERC-8021 builder code (optional attribution). */
  builderCode?: string;
  onRefresh?: () => void;
}

/** atomic → decimal string, purely for display. Never used for any on-chain
 * amount (the server owns every exact value). */
export function formatEarnAmountForDisplayV1(amountAtomic: string, decimals: number): string {
  try {
    const value = BigInt(amountAtomic);
    if (decimals === 0) return value.toString();
    const base = BigInt(10) ** BigInt(decimals);
    const whole = value / base;
    const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  } catch {
    return amountAtomic;
  }
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function EarnDepositReview({ prepared }: { prepared: PreparedEarn }) {
  const blueprint = prepared.blueprint;
  const approval = blueprint.requiredApprovals[0] ?? null;
  // The deposit call is the non-approval call; its `to` is the pinned protocol
  // contract (Moonwell market / Morpho vault) the USDC is supplied into.
  const depositCall = blueprint.calls.find((call) => call.callType !== 'approval') ?? blueprint.calls[blueprint.calls.length - 1];
  const expiryMs = Date.parse(blueprint.quoteExpiry);
  const expiryLabel = Number.isFinite(expiryMs) ? new Date(expiryMs).toLocaleString() : blueprint.quoteExpiry;

  return (
    <section className="mt-4 rounded-2xl border border-line bg-panel p-5" aria-label="Earn deposit review" data-earn-review="prepared">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-semibold text-ink">Review deposit</h3>
        <span
          className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${
            prepared.safety.verdict === 'allowed' ? 'bg-accent-soft text-accent-2' : 'bg-warn-soft text-warn'
          }`}
        >
          Safety: {prepared.safety.verdict}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-3">
        The server prepared these exact calls — nothing is signed until you confirm in your Base Account.
      </p>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Quote expiry</dt>
          <dd className="mt-1 font-mono text-ink">{expiryLabel}</dd>
        </div>
        {approval && (
          <div>
            <dt className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Exact approval</dt>
            <dd className="mt-1 font-mono text-ink">
              {formatEarnAmountForDisplayV1(approval.amountAtomic, approval.asset.decimals)} {approval.asset.symbol}
              <span className="ml-1 text-[11px] text-ink-3">({approval.approvalKind})</span>
            </dd>
            <dd className="mt-0.5 font-mono text-[11px] text-ink-3">→ {shortAddress(approval.spender)}</dd>
          </div>
        )}
        {depositCall && (
          <div>
            <dt className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Protocol contract</dt>
            <dd className="mt-1 font-mono text-ink">{shortAddress(depositCall.to)}</dd>
          </div>
        )}
        <div>
          <dt className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Calls</dt>
          <dd className="mt-1 font-mono text-ink">{blueprint.calls.map((call) => call.callType).join(' + ')}</dd>
        </div>
      </dl>
    </section>
  );
}

export interface EarnProofState {
  status: BlueprintSubmitStatus;
  proofId: string | null;
  recordedFinalStatus: string | null;
  txHashes: string[];
  error: string | null;
}

/** The honest user-facing Route Proof message for an earn deposit. Crucially,
 * `reconciliation_required` is surfaced as an explicit "not yet proven" state —
 * a submitted/confirmed receipt is NEVER presented as a proven deposit. Pure so
 * the reconciliation-required journey is unit-testable without a DOM. */
export function earnProofStatusMessageV1(state: EarnProofState): string {
  switch (state.recordedFinalStatus) {
    case 'reconciliation_required':
      return 'Submitted — the deposit could not be proven from receipts yet and needs reconciliation.';
    case 'completed':
      return 'Deposit confirmed and the position was proven onchain.';
    case 'partial_failure':
      return 'Submitted — only part of the batch succeeded; the deposit needs reconciliation.';
    case 'failed':
      return 'The deposit failed onchain.';
    case null:
    case undefined:
      return `Status: ${state.status}.`;
    default:
      return `Recorded — proof status: ${state.recordedFinalStatus}.`;
  }
}

function EarnProofStatus({ state }: { state: EarnProofState }) {
  const finalized = state.recordedFinalStatus;
  return (
    <div className="mt-3 rounded-xl border border-line bg-bg/50 p-4 text-sm" aria-live="polite" data-earn-proof-status={finalized ?? state.status}>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">Route Proof</p>
      <p className="mt-1 text-ink">{earnProofStatusMessageV1(state)}</p>
      {state.proofId && <p className="mt-1 font-mono text-[11px] text-ink-3">Proof: {state.proofId}</p>}
      {state.error && <p className="mt-1 text-xs text-warn">{state.error}</p>}
    </div>
  );
}

export function EarnDepositFlow({ routeRunId, routeCard, builderCode, onRefresh }: EarnDepositFlowProps) {
  const { address } = useAccount();
  const prepare = usePrepareEarnDeposit();
  const [selected, setSelected] = useState<string | null>(routeCard.recommendedCandidateHash ?? null);
  const [prepared, setPrepared] = useState<PreparedEarn | null>(null);
  const [proofState, setProofState] = useState<EarnProofState | null>(null);

  const view = deriveEarnRouteCardViewV1(routeCard);

  const onReviewDeposit = (candidateHash: string) => {
    if (!address) return;
    setPrepared(null);
    setProofState(null);
    prepare.mutate(
      {
        walletAddress: address.toLowerCase() as `0x${string}`,
        routeRunId,
        routeCardHash: routeCard.routeCardHash,
        selectedCandidateHash: candidateHash,
      },
      {
        onSuccess: (result) => {
          if (result.outcome === 'prepared') setPrepared(result);
        },
      },
    );
  };

  const refreshRequired = prepare.data?.outcome === 'refresh_required' || prepare.data?.outcome === 'expired';

  return (
    <div>
      <EarnRouteCardView
        view={view}
        selectedCandidateHash={selected}
        onSelectCandidate={(hash) => {
          setSelected(hash);
          setPrepared(null);
          setProofState(null);
          prepare.reset();
        }}
        onReviewDeposit={onReviewDeposit}
        reviewPending={prepare.isPending}
        onRefresh={onRefresh}
      />

      {prepare.isError && (
        <p className="mt-3 text-sm text-warn" role="alert">
          The deposit could not be prepared: {prepare.error?.message}
        </p>
      )}
      {refreshRequired && (
        <p className="mt-3 text-sm text-warn" role="alert" data-earn-review="refresh_required">
          This comparison is stale — refresh the earn routes and select again.
        </p>
      )}
      {prepare.data?.outcome === 'blocked' && (
        <p className="mt-3 text-sm text-warn" role="alert" data-earn-review="blocked">
          Blocked by the Earn Safety Kernel: {prepare.data.reason}
        </p>
      )}

      {prepared && (
        <>
          <EarnDepositReview prepared={prepared} />
          <div className="mt-3">
            <BlueprintSubmitButton
              goal="earn"
              routeRunId={routeRunId}
              blueprintId={prepared.blueprint.id}
              blueprintHash={prepared.blueprint.blueprintHash}
              quoteExpiry={prepared.blueprint.quoteExpiry}
              builderCode={builderCode}
              onStateChange={(next) =>
                setProofState({
                  status: next.status,
                  proofId: next.proofId,
                  recordedFinalStatus: next.recordedFinalStatus,
                  txHashes: next.txHashes,
                  error: next.error,
                })
              }
            />
          </div>
          {proofState && <EarnProofStatus state={proofState} />}
        </>
      )}
    </div>
  );
}
