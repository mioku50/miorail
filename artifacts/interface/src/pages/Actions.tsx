import { useActionsFeed, useExecuteAction, useDismissAction } from '@mioagent/api-client-react';

export function Actions() {
  const { data, isLoading, refetch } = useActionsFeed();
  const executeAction = useExecuteAction();
  const dismissAction = useDismissAction();
  const isMainnetReadonly = import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly';

  if (isLoading) return <div className="p-6">Loading actions...</div>;

  const actions = data?.actions || [];

  const handleExecute = (actionId: string, action: any) => {
    if (isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') {
      alert("Mainnet execution is disabled in read-only mode.");
      return;
    }
    executeAction.mutate({ actionId }, { onSuccess: () => refetch() });
  };

  const handleDismiss = (actionId: string) => {
    dismissAction.mutate({ actionId }, { onSuccess: () => refetch() });
  };

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-6">Actions</h2>
      {actions.length === 0 ? (
        <p className="text-slate-600">No actions found.</p>
      ) : (
        <div className="grid gap-4">
          {actions.map((action: any) => (
            <div key={action.id} className="bg-white border rounded-lg p-4 shadow-sm">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <span className="inline-block px-2 py-1 text-xs font-semibold bg-slate-100 text-slate-700 rounded mr-2">
                    {action.kind}
                  </span>
                  <span className={`inline-block px-2 py-1 text-xs font-semibold rounded ${
                    action.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                    action.status === 'executed' ? 'bg-green-100 text-green-800' :
                    action.status === 'dismissed' ? 'bg-gray-100 text-gray-800' :
                    'bg-red-100 text-red-800'
                  }`}>
                    {action.status}
                  </span>
                </div>
                <div className="text-sm text-slate-500">
                  {new Date(action.createdAt).toLocaleString()}
                </div>
              </div>

              {action.suggestedPrompt && (
                <div className="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded border">
                  <strong>Suggested:</strong> {action.suggestedPrompt}
                </div>
              )}

              {(() => {
                 const meta = action.metadata || {};
                 const reason = meta.reason;
                 const expectedEffect = meta.expectedEffect;
                 const risk = meta.risk || 'medium';
                 const chainMode = meta.chainMode || (isMainnetReadonly ? 'mainnet-readonly' : 'sepolia');
                 const safetyState = meta.safetyState || (action.status === 'failed' ? 'blocked' : 'safe');

                 return (
                   <div className="mt-2 text-xs bg-slate-50 p-3 rounded border border-slate-200 flex flex-col gap-1.5">
                     {reason && <div><strong className="text-slate-700">Reason:</strong> <span className="text-slate-600">{reason}</span></div>}
                     {expectedEffect && <div><strong className="text-slate-700">Expected Effect:</strong> <span className="text-slate-600">{expectedEffect}</span></div>}
                     <div className="flex gap-2 mt-1">
                       <span className="px-2 py-0.5 bg-yellow-50 text-yellow-800 rounded border border-yellow-200">Risk: {risk}</span>
                       <span className="px-2 py-0.5 bg-gray-100 text-gray-800 rounded border border-gray-200">Chain: {chainMode}</span>
                       <span className="px-2 py-0.5 bg-blue-50 text-blue-800 rounded border border-blue-200">Safety: {safetyState}</span>
                     </div>
                   </div>
                 );
              })()}

              {action.tokens && action.tokens.length > 0 && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  {action.tokens.map((token: string, i: number) => (
                    <span key={i} className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded border border-blue-100">
                      {token}
                    </span>
                  ))}
                </div>
              )}

              {action.status === 'pending' && (
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={() => handleExecute(action.id, action)}
                    disabled={executeAction.isPending || dismissAction.isPending || isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet'}
                    className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                  >
                    {executeAction.isPending ? 'Executing...' : (isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') ? 'Read-only' : 'Approve'}
                  </button>
                  <button
                    onClick={() => handleDismiss(action.id)}
                    disabled={executeAction.isPending || dismissAction.isPending}
                    className="px-4 py-2 bg-slate-200 text-slate-800 rounded-md text-sm font-medium hover:bg-slate-300 disabled:opacity-50"
                  >
                    {dismissAction.isPending ? 'Dismissing...' : 'Reject'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
