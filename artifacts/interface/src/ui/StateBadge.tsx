import { cn } from '../lib/cn';

// Honest-states system: any widget that shows data must wrap it in a StateBadge
// (or a StateBadge-equivalent) so the source/freshness is always visible.
export type StateKind =
  | 'live'
  | 'cached'
  | 'stale'
  | 'mock'
  | 'disconnected'
  | 'missing'
  | 'disabled'
  | 'failed';

const MAP: Record<StateKind, { tone: string; dot: string; label: string }> = {
  live: { tone: 'text-ok border-ok/30 bg-ok-soft', dot: 'bg-ok', label: 'live' },
  cached: { tone: 'text-ink-2 border-line bg-panel-2', dot: 'bg-ink-3', label: 'cached' },
  stale: { tone: 'text-warn border-warn/30 bg-warn-soft', dot: 'bg-warn', label: 'stale' },
  mock: { tone: 'text-ink-2 border-line bg-panel-2', dot: 'bg-ink-3', label: 'mock' },
  disconnected: { tone: 'text-risk border-risk/30 bg-risk-soft', dot: 'bg-risk', label: 'disconnected' },
  missing: { tone: 'text-warn border-warn/30 bg-warn-soft', dot: 'bg-warn', label: 'missing' },
  disabled: { tone: 'text-ink-3 border-line bg-panel-2', dot: 'bg-ink-3', label: 'disabled' },
  failed: { tone: 'text-risk border-risk/30 bg-risk-soft', dot: 'bg-risk', label: 'failed' },
};

export interface StateBadgeProps {
  state: StateKind;
  /** Override the auto label (e.g. provider name). */
  label?: string;
  /** Native title tooltip — use for source + age, e.g. "Moralis · 12s old". */
  title?: string;
  className?: string;
}

export function StateBadge({ state, label, title, className }: StateBadgeProps) {
  const m = MAP[state];
  return (
    <span
      title={title ?? label ?? m.label}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.06em]',
        m.tone,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />
      {label ?? m.label}
    </span>
  );
}
