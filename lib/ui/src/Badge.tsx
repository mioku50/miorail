import { type HTMLAttributes } from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'risk';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-panel-2 text-ink-2',
  accent: 'bg-accent-soft text-accent-2',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  risk: 'bg-risk-soft text-risk',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium font-sans',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
