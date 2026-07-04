import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useActionsFeed, useClearActions, useDismissAllRecommendations, useDeleteAllRecommendations } from '@mioagent/api-client-react';
import { useUiStore } from '../../lib/state';
import { ActionCard } from './ActionCard';

const FILTERS = ['all', 'signals', 'recommendations', 'blocked', 'history'];

export function ActionInbox() {
  const [, navigate] = useLocation();
  const { data, isLoading, refetch } = useActionsFeed();
  const clearActions = useClearActions();
  const dismissAllRecs = useDismissAllRecommendations();
  const deleteAllRecs = useDeleteAllRecommendations();
  const showToast = useUiStore((s) => s.showToast);
  const filter = useUiStore((s) => s.inboxFilter);
  const setFilter = useUiStore((s) => s.setInboxFilter);
  const focusActionId = useUiStore((s) => s.focusActionId);
  const clearFocus = useUiStore((s) => s.clearFocus);
  const [showManageMenu, setShowManageMenu] = useState(false);

  const allActions = data?.actions || [];
  const actions = allActions.filter((a: any) => {
    if (filter === 'all') return a.status === 'pending';
    if (filter === 'signals') return a.status === 'pending' && (a.kind === 'signal' || a.kind === 'alert' || a.kind === 'transfer' || a.kind === 'swap');
    if (filter === 'recommendations') return a.status === 'pending' && a.kind === 'recommendation';
    if (filter === 'blocked') return a.status === 'pending' && (a.status === 'failed' || a.metadata?.safetyState === 'blocked' || a.metadata?.safetyState === 'failed');
    if (filter === 'history') return a.status === 'dismissed' || a.status === 'executed' || a.status === 'failed';
    return a.status === 'pending';
  });

  // Scroll to a focused action (deep-link / "View in Action Inbox") once loaded.
  useEffect(() => {
    if (!focusActionId) return;
    const el = document.getElementById(`action-${focusActionId}`) || document.querySelector(`[data-action-id="${focusActionId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      clearFocus();
    }
  }, [focusActionId, actions, clearFocus]);

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto pb-16 md:pb-5">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">Action Inbox</h1>
        <div className="flex gap-1.5 items-center flex-wrap">
          {FILTERS.map((f) => (
            <div key={f} onClick={() => setFilter(f)} className={`px-[11px] py-[5px] rounded-[9px] text-[12px] font-medium border cursor-pointer capitalize ${filter === f ? 'bg-accent text-white border-accent' : 'bg-panel text-ink-2 border-line hover:bg-bg'}`}>
              {f}
            </div>
          ))}

          <div className="relative ml-2">
            <button
              onClick={() => setShowManageMenu(!showManageMenu)}
              className="px-3 py-1.5 bg-panel border border-line rounded-[9px] text-xs font-semibold text-ink hover:bg-bg transition-colors flex items-center gap-1 shadow-sm"
            >
              Manage ▾
            </button>
            {showManageMenu && (
              <div className="absolute right-0 mt-1 w-64 bg-panel border border-line rounded-xl shadow-lg py-1 z-50 animate-in fade-in zoom-in-95">
                <button
                  onClick={() => {
                    setShowManageMenu(false);
                    dismissAllRecs.mutate(undefined, {
                      onSuccess: (res: any) => {
                        showToast(`Dismissed ${res?.count || 'all'} recommendations`);
                        refetch();
                      },
                    });
                  }}
                  disabled={dismissAllRecs.isPending}
                  className="w-full text-left px-3 py-2 text-xs text-ink hover:bg-bg transition-colors block font-medium"
                >
                  Dismiss all recommendations
                </button>
                <button
                  onClick={() => {
                    setShowManageMenu(false);
                    if (confirm('Permanently delete all recommendations? This cannot be undone.')) {
                      deleteAllRecs.mutate({ confirm: true }, {
                        onSuccess: (res: any) => {
                          showToast(`Deleted ${res?.count || 'all'} recommendations`);
                          refetch();
                        },
                      });
                    }
                  }}
                  disabled={deleteAllRecs.isPending}
                  className="w-full text-left px-3 py-2 text-xs text-risk hover:bg-risk-soft transition-colors block font-medium border-t border-line"
                >
                  Delete all recommendations
                </button>
                <button
                  onClick={() => {
                    setShowManageMenu(false);
                    if (confirm('This removes seeded demo actions only. Your recommendations will stay. Proceed?')) {
                      clearActions.mutate(undefined, {
                        onSuccess: (res: any) => {
                          if (res && res.count === 0) {
                            showToast('No demo actions to clear.');
                          } else {
                            showToast('Seeded demo actions cleared');
                          }
                          refetch();
                        },
                      });
                    }
                  }}
                  disabled={clearActions.isPending}
                  title="This removes seeded demo actions only. Your recommendations will stay."
                  className="w-full text-left px-3 py-2 text-xs text-ink-2 hover:bg-bg transition-colors block border-t border-line"
                >
                  Clear demo actions
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {isLoading && <div className="text-sm text-ink-3">Loading...</div>}
        {!isLoading && actions.length === 0 && (
          <div className="bg-panel border border-line rounded-xl p-8 text-center flex flex-col items-center gap-3 my-4">
            <div className="w-10 h-10 rounded-full bg-accent-soft text-accent flex items-center justify-center text-lg font-bold">⚡</div>
            <div className="text-base font-bold text-ink">No pending automated actions right now</div>
            <div className="text-xs text-ink-2 max-w-md leading-relaxed">
              Actions represent automated operations recommendations, token approvals, rebalances, or security screens.
            </div>
            <div className="text-xs text-ink-3 font-medium bg-bg px-3 py-1.5 rounded-lg border border-line mt-1">
              Create a new action recommendation below or interact with Agent Stream.
            </div>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => navigate('/build')}
                className="px-3 py-1.5 bg-accent text-white text-xs rounded-lg font-medium hover:opacity-90 transition-opacity shadow-sm"
              >
                Create in Actions Builder
              </button>
              <button
                onClick={() => {
                  const el = document.getElementById('agent-stream-input');
                  if (el) el.focus();
                }}
                className="px-3 py-1.5 bg-bg border border-line text-ink text-xs rounded-lg font-medium hover:bg-panel transition-colors"
              >
                Ask Agent Stream
              </button>
            </div>
          </div>
        )}
        {actions.map((action: any) => (
          <ActionCard key={action.id} action={action} onRefresh={refetch} />
        ))}
      </div>
    </main>
  );
}
