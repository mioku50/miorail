// T58: pure presentational Route Proof panel (wagmi-free by design). The
// surfaces feed it the reconciled projection from the API; this component
// only renders what it is told — it never polls, reconciles, or invents
// outcomes. Honest states: a pending proof says so, and a
// reconciliation_required proof explains exactly WHY the output could not be
// independently reconstructed instead of pretending success.

import React from 'react';
import { Badge } from './Badge';
import { baseExplorerTxUrl } from './SubmissionStatus';
import { formatAtomicAmount } from './formatAtomicAmount';

void React;

export interface ExecutionProofAssetView {
  symbol: string;
  decimals: number;
  address: string | null;
  kind: 'native' | 'erc20';
}

export interface ExecutionProofGasView {
  gasUnits: string;
  maxFeePerGasWei: string | null;
  estimatedCostNative: string | null;
  estimatedCostUsd: string | null;
}

export interface ExecutionProofReceiptView {
  transactionHash: string;
  status: 'success' | 'reverted' | 'unknown';
  blockNumber: string | null;
  gasUsed: string | null;
}

/** Structural mirror of the API's RouteProofProjectionV1 so lib/ui stays
 * dependency-free — surfaces pass their api-spec objects directly. */
export interface ExecutionProofView {
  proofId: string;
  blueprintHash: string;
  approvedCallsHash: string;
  provider: string | null;
  expectedOutput: { amountAtomic: string; asset: ExecutionProofAssetView };
  minimumOutput: string | null;
  actualOutput: string | null;
  outputDeviationBps: number | null;
  minimumSatisfied: boolean | null;
  estimatedGas: ExecutionProofGasView;
  actualGas: ExecutionProofGasView | null;
  transactionHashes: string[];
  receipts: ExecutionProofReceiptView[];
  finalStatus: 'pending' | 'completed' | 'partial_failure' | 'failed' | 'cancelled' | 'reconciliation_required';
  reconciliationState: 'pending' | 'matched' | 'deviated' | 'partial' | 'failed' | 'manual_review';
}

export interface ExecutionProofPanelProps {
  proof: ExecutionProofView;
  lifecycle: string;
  explorerTxUrl?: (hash: string) => string | null;
}

const RECEIPT_TONE: Record<ExecutionProofReceiptView['status'], 'ok' | 'risk' | 'warn'> = {
  success: 'ok',
  reverted: 'risk',
  unknown: 'warn',
};

const FINAL_STATUS_TONE: Record<ExecutionProofView['finalStatus'], 'neutral' | 'ok' | 'warn' | 'risk'> = {
  pending: 'neutral',
  completed: 'ok',
  partial_failure: 'warn',
  failed: 'risk',
  cancelled: 'neutral',
  reconciliation_required: 'warn',
};

export const NATIVE_OUTPUT_MANUAL_RECONCILIATION_COPY =
  'Transaction succeeded, but exact native ETH output could not be independently reconstructed. Manual reconciliation required.';

function truncatedHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

export function formatDeviationBps(outputBps: number | null): string | null {
  if (outputBps === null) return null;
  const percent = (outputBps / 100).toFixed(2);
  return outputBps > 0 ? `+${percent}%` : `${percent}%`;
}

export function ExecutionProofPanel({ proof, lifecycle, explorerTxUrl = baseExplorerTxUrl }: ExecutionProofPanelProps) {
  const asset = proof.expectedOutput.asset;
  const format = (amountAtomic: string) => `${formatAtomicAmount(amountAtomic, asset.decimals)} ${asset.symbol}`;
  const deviation = formatDeviationBps(proof.outputDeviationBps);
  const pending = proof.finalStatus === 'pending';
  const manualReview = proof.finalStatus === 'reconciliation_required';

  return (
    <section
      aria-label="Execution proof"
      data-proof-final-status={proof.finalStatus}
      className="rounded-xl border border-line bg-panel p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold text-ink">Execution proof</h3>
        <div className="flex items-center gap-2">
          <Badge tone={FINAL_STATUS_TONE[proof.finalStatus]}>{proof.finalStatus}</Badge>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">{proof.reconciliationState}</span>
        </div>
      </div>

      {pending && (
        <p className="mt-2 text-xs text-ink-2">
          Pending confirmation… Receipts have not been independently verified onchain yet. Nothing is assumed successful
          until they are.
        </p>
      )}

      {manualReview && (
        <p className="mt-2 text-xs text-warn" data-proof-copy="manual-reconciliation">
          {NATIVE_OUTPUT_MANUAL_RECONCILIATION_COPY}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        {proof.provider && (
          <div>
            <dt className="text-ink-3">Provider</dt>
            <dd className="mt-0.5 font-mono text-ink">{proof.provider}</dd>
          </div>
        )}
        <div>
          <dt className="text-ink-3">Expected output</dt>
          <dd className="mt-0.5 font-mono text-ink">{format(proof.expectedOutput.amountAtomic)}</dd>
        </div>
        {proof.minimumOutput !== null && (
          <div>
            <dt className="text-ink-3">Minimum output</dt>
            <dd className="mt-0.5 font-mono text-ink">{format(proof.minimumOutput)}</dd>
          </div>
        )}
        <div>
          <dt className="text-ink-3">Actual output</dt>
          <dd className="mt-0.5 font-mono text-ink">
            {proof.actualOutput !== null ? format(proof.actualOutput) : 'not verified'}
          </dd>
        </div>
        {deviation !== null && (
          <div>
            <dt className="text-ink-3">Deviation</dt>
            <dd className={`mt-0.5 font-mono ${proof.minimumSatisfied === false ? 'text-warn' : 'text-ink'}`}>
              {deviation}
              {proof.minimumSatisfied === false ? ' · below minimum' : ''}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-ink-3">Estimated gas</dt>
          <dd className="mt-0.5 font-mono text-ink">
            {proof.estimatedGas.gasUnits} units
            {proof.estimatedGas.estimatedCostUsd ? ` · $${proof.estimatedGas.estimatedCostUsd}` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Actual gas</dt>
          <dd className="mt-0.5 font-mono text-ink">
            {proof.actualGas
              ? `${proof.actualGas.gasUnits} units${proof.actualGas.estimatedCostNative ? ` · ${proof.actualGas.estimatedCostNative} ETH` : ''}`
              : 'not verified'}
          </dd>
        </div>
      </dl>

      {proof.transactionHashes.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Verified receipts</p>
          <ul className="mt-2 space-y-1.5">
            {proof.transactionHashes.map((hash) => {
              const receipt = proof.receipts.find((entry) => entry.transactionHash === hash) ?? null;
              const href = explorerTxUrl(hash);
              return (
                <li key={hash} className="flex items-center gap-2 font-mono text-[11px]">
                  <Badge tone={RECEIPT_TONE[receipt?.status ?? 'unknown']}>{receipt?.status ?? 'unknown'}</Badge>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="break-all underline text-ink-2">
                      {hash}
                    </a>
                  ) : (
                    <span className="break-all text-ink-2">{hash}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 font-mono text-[10px] text-ink-3">
        <span title={proof.blueprintHash}>blueprint {truncatedHash(proof.blueprintHash)}</span>
        <span title={proof.approvedCallsHash}>calls {truncatedHash(proof.approvedCallsHash)}</span>
        <span>lifecycle {lifecycle}</span>
      </div>
    </section>
  );
}
