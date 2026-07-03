import { type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'risk';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-panel-2 text-ink-2 border-line',
  accent: 'bg-accent-soft text-accent border-accent/30',
  ok: 'bg-ok-soft text-ok border-ok/30',
  warn: 'bg-warn-soft text-warn border-warn/30',
  risk: 'bg-risk-soft text-risk border-risk/30',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-mono uppercase tracking-[0.06em]',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
