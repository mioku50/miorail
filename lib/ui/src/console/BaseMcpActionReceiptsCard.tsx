import { activityBaseScanTxUrlV1, activityShortHashV1 } from './ActivityPanels';

interface BaseMcpActivityReceiptCommonV1 {
  id: string;
  status: string;
  provider: 'base-mcp';
  reconciliationState: string;
  transactionHash: string | null;
  blockNumber: string | null;
  errorCode: string | null;
  createdAt: string;
  routeVerified: false;
}

export type BaseMcpActivityReceiptV1 = BaseMcpActivityReceiptCommonV1 & (
  | { actionType: 'send'; amount: string; asset: { symbol: string }; recipient: string }
  | { actionType: 'x402'; method: 'GET'; url: string; maxPayment: string; paymentAsset: { symbol: string }; responseHash: string | null }
);

function tone(status: string): string {
  if (status === 'completed') return 'g';
  if (['approval_required', 'pending', 'reconciling'].includes(status)) return 'a';
  return 'n';
}

export function BaseMcpActionReceiptsCard(model: {
  loading: boolean;
  receipts: readonly BaseMcpActivityReceiptV1[];
  unavailableReason: string | null;
}) {
  return (
    <div className="rp">
      <div className="rph">
        <b>Base MCP action receipts</b>
        <span className="rt mono">{model.receipts.length || '—'}</span>
      </div>
      <div className="rpb">
        <p className="lnote">
          Durable status for direct extension actions reviewed through Base Account. These are
          Action Receipts, not compared routes and not Route Proofs.
        </p>
        {model.loading && model.receipts.length === 0 ? (
          <p className="empty">Reading Base MCP action receipts…</p>
        ) : model.unavailableReason ? (
          <p className="empty">{model.unavailableReason}</p>
        ) : model.receipts.length === 0 ? (
          <p className="empty">No Base MCP actions have been prepared for this account.</p>
        ) : (
          model.receipts.map((receipt) => (
            <div key={receipt.id}>
              <div className="qrow">
                <span className={`pill ${tone(receipt.status)}`}>{receipt.status}</span>
                <span className="v mono">
                  {receipt.actionType === 'send'
                    ? `${receipt.amount} ${receipt.asset.symbol}`
                    : `x402 ≤ ${receipt.maxPayment} ${receipt.paymentAsset.symbol}`}
                </span>
              </div>
              <p className="lnote mono">
                {receipt.actionType === 'send' ? `to ${receipt.recipient}` : receipt.url}
              </p>
              <p className="lnote">
                Base MCP · {receipt.reconciliationState} · {new Date(receipt.createdAt).toLocaleString()}
              </p>
              {receipt.transactionHash && (
                <p className="lnote">
                  <a
                    className="mono"
                    href={activityBaseScanTxUrlV1(receipt.transactionHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {activityShortHashV1(receipt.transactionHash)}
                  </a>
                  {receipt.blockNumber ? ` · block ${receipt.blockNumber}` : ''}
                </p>
              )}
              {receipt.errorCode && <p className="lnote">{receipt.errorCode}</p>}
              {receipt.actionType === 'x402' && receipt.responseHash && (
                <p className="lnote mono">response {activityShortHashV1(receipt.responseHash)}</p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
