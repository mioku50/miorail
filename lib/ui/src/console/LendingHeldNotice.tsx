import React, { useEffect, useState } from 'react';
import { lendingRequestV1 } from '@mioagent/api-client-react';
import { lendingHeldByWireV1, type LendingHeldByV1 } from './lendingReviewView';

void React;

// ---------------------------------------------------------------------------
// A loan or repayment of this wallet that has not settled holds its market (on
// Aave V4, the whole stocks spoke) against every other one. Said on Repay and
// Get money before any refusal does, with the way to that attempt's own review
// (audit UI-19, 2026-11-14: on a phone whose tab was lost the refusal named
// "that review", and nothing on Still led back to it).
// ---------------------------------------------------------------------------

/** The signed-in wallet's attempts that still hold a market, read once per wallet. Empty when there are
 * none, when signed out, or when they could not be read: this only adds a line, it never blocks. */
export function useLendingHeldV1(input: { signedIn: boolean; walletIdentity: string | null }): LendingHeldByV1[] {
  const owner = input.signedIn ? input.walletIdentity?.toLowerCase() ?? null : null;
  const [held, setHeld] = useState<{ owner: string | null; rows: LendingHeldByV1[] }>({ owner: null, rows: [] });
  useEffect(() => {
    if (!owner) return undefined;
    let live = true;
    lendingRequestV1<{ held?: unknown }>('/api/route-intelligence/rwa/lending/held')
      .then(answer => {
        if (!live) return;
        const rows = Array.isArray(answer?.held) ? answer.held.map(lendingHeldByWireV1).filter((row): row is LendingHeldByV1 => row !== null && row.href !== null) : [];
        setHeld({ owner, rows });
      }, () => { if (live) setHeld({ owner, rows: [] }); });
    return () => { live = false; };
  }, [owner]);
  return held.owner === owner && owner ? held.rows : [];
}

const timeV1 = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** One line per attempt that holds a market, each with its own review. */
export function LendingHeldNoticeV1({ held }: { held: readonly LendingHeldByV1[] }) {
  if (held.length === 0) return null;
  return <div className="still-section">
    {held.map(row => <p key={row.href} className="still-note" role="status">
      Your {row.operation === 'repay' ? 'repayment' : 'loan'} against {row.collateralSymbol} has not settled yet, and while it waits that market takes no
      other loan or repayment from your wallet. <a href={row.href!}>Open it</a> to see its result{row.releaseFrom
        ? `; if your wallet never sent it, it can be released there${Date.parse(row.releaseFrom) > Date.now() ? ` from ${timeV1(row.releaseFrom)}` : ''}` : ''}.
    </p>)}
  </div>;
}
