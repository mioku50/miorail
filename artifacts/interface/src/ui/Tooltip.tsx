import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  const [show, setShow] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-sm border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink-2 shadow-sm',
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
