import { useActionsFeed, useExecuteAction, useDismissAction } from '@mioagent/api-client-react';

export function Actions() {
  const { data, isLoading, refetch } = useActionsFeed();
  const executeAction = useExecuteAction();
  const dismissAction = useDismissAction();

  if (isLoading) return <div className="p-6">Loading actions...</div>;

  const actions = data?.actions || [];

  const handleExecute = (actionId: string) => {
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
          {actions.map((action) => (
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

              {action.tokens && action.tokens.length > 0 && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  {action.tokens.map((token, i) => (
                    <span key={i} className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded border border-blue-100">
                      {token}
                    </span>
                  ))}
                </div>
              )}

              {action.status === 'pending' && (
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={() => handleExecute(action.id)}
                    disabled={executeAction.isPending || dismissAction.isPending}
                    className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                  >
                    {executeAction.isPending ? 'Executing...' : 'Approve'}
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
