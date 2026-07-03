import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from './cn';

// Thin border instead of a soft shadow — the engineering-terminal look.
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('rounded-lg border border-line bg-panel', className)} {...props} />
  ),
);
Card.displayName = 'Card';
