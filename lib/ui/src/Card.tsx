import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from './cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-line bg-panel shadow-[var(--shadow-card)]',
        interactive &&
          'transition-all duration-150 hover:border-accent-soft hover:-translate-y-px cursor-pointer',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';
