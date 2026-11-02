import { useSyncExternalStore } from 'react';
import { stillCardReviewHostV1, type StillCardPhaseV1 } from './stillCardView';
import type { StillCardHostV1, StillCardStoreV1 } from './stillCardStore';
import { StillCardSign } from './StillCardSign';

// What the person sees in the chat: what the assistant prepared, the one way to
// review and sign it (on Still, in their own wallet), and where it stands.

const STEPS_V1: Array<{ label: string; phases: StillCardPhaseV1[] }> = [
  { label: 'Prepared', phases: ['waiting', 'expired', 'open', 'wallet', 'sent', 'unknown', 'confirmed', 'failed'] },
  { label: 'Opened', phases: ['open', 'wallet', 'sent', 'unknown', 'confirmed', 'failed'] },
  { label: 'Sent', phases: ['sent', 'unknown', 'confirmed', 'failed'] },
  { label: 'Confirmed onchain', phases: ['confirmed'] },
];

function untilV1(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt);
  return Number.isFinite(at.getTime()) ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
}

export function StillCard({ store, host, projectId }: { store: StillCardStoreV1; host: Pick<StillCardHostV1, 'callServerTool'>; projectId: string | null }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { prepared, status } = state;
  const phase = status?.phase ?? 'waiting';
  const settled = status?.settled ?? false;
  return (
    <div className="still still-mcp-card" data-sky={state.dark ? 'night' : 'day'}>
      <div className="still-card">
        <div className="still-eyebrow">Still · {prepared?.kind === 'purchase' ? 'purchase' : prepared?.kind === 'repay' ? 'repayment' : 'loan'} review</div>
        {state.refusal ? <p className="still-warn" role="alert">{state.refusal}</p> : null}
        {prepared ? (
          <>
            <h1 className="still-mcp-title">{prepared.title}</h1>
            <p className="still-sub">{prepared.detail}</p>
            <ol className="still-mcp-steps" aria-label="Where it stands">
              {STEPS_V1.map((step) => (
                <li key={step.label} data-done={step.phases.includes(phase) && !(phase === 'failed' && step.label === 'Confirmed onchain') ? 'yes' : 'no'}>{step.label}</li>
              ))}
            </ol>
            {phase === 'confirmed' ? (
              <p className="still-mcp-done" role="status"><span aria-hidden="true">✓</span> {status?.line}</p>
            ) : (
              <p className={phase === 'failed' || phase === 'expired' ? 'still-warn' : 'still-note'} role="status">
                {status?.line ?? 'Reading where it stands…'}
              </p>
            )}
            {status?.bitrefill ? <p className="still-note">{status.bitrefill}</p> : null}
            {state.statusUnread ? <p className="still-note">Still could not read the status just now. This is our failure; it says nothing about the transaction.</p> : null}
            <div className="still-mcp-actions">
              {!settled && phase !== 'expired' && prepared.reviewUrl ? (
                <button type="button" className="still-btn" onClick={() => void store.openReview()}>Review and sign on {stillCardReviewHostV1(prepared.reviewUrl)}</button>
              ) : null}
              {status?.shareUrl ? <button type="button" className="still-btn" onClick={() => void store.openShare()}>Share the purchase</button> : null}
              {status?.transactionHash ? <button type="button" className="still-btn sec" onClick={() => void store.openTransaction()}>View on BaseScan</button> : null}
              {!settled ? (
                <button type="button" className="still-btn sec" disabled={state.following} onClick={() => store.checkAgain()}>
                  {state.following ? 'Following…' : 'Check again'}
                </button>
              ) : null}
            </div>
            {state.linkRefused ? <p className="still-note">The chat did not open the link. It is in the assistant’s message too.</p> : null}
            {projectId && prepared.reviewUrl && !settled && phase !== 'expired' ? (
              <StillCardSign host={host} projectId={projectId} draft={prepared.reviewUrl.slice(prepared.reviewUrl.indexOf('/lending/') + '/lending/'.length)}
                reviewHost={stillCardReviewHostV1(prepared.reviewUrl)} onSent={() => store.checkAgain()} />
            ) : null}
            {settled ? null : (
              <p className="still-note still-mcp-foot">
                {projectId ? 'Either way the review reads everything again, and only your own wallet signs.'
                  : 'The review reads everything again and your own wallet signs there; nothing is sent from this card.'}
                {phase === 'waiting' && untilV1(prepared.expiresAt) ? ` The link works until ${untilV1(prepared.expiresAt)}.` : ''}
              </p>
            )}
          </>
        ) : state.refusal ? null : <p className="still-note" role="status">Waiting for the assistant’s result…</p>}
      </div>
    </div>
  );
}
