import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function Dialog({ open, onOpenChange, children, className, title }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onMouseDown={() => onOpenChange(false)}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          'relative z-10 w-full max-w-lg rounded-[var(--radius-lg)] border border-line bg-panel p-5 shadow-[var(--shadow-card)]',
          className,
        )}
      >
        {title && <div className="mb-3 text-sm font-semibold text-ink font-display">{title}</div>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
