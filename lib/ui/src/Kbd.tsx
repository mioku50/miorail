import { type ReactNode } from 'react';
import { cn } from './cn';

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line bg-panel-2 px-1.5 font-mono text-[11px] text-ink-2',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
