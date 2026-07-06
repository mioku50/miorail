import React, { forwardRef, type ButtonHTMLAttributes } from 'react';
void React;
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'risk';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

const variants: Record<Variant, string> = {
  primary:
    'bg-gradient-to-r from-accent to-accent-2 text-white shadow-[var(--shadow-glow-accent)] hover:shadow-[var(--shadow-glow-accent)] hover:brightness-110',
  secondary:
    'bg-transparent text-ink border border-line hover:bg-panel-2 hover:border-ink-3',
  ghost: 'text-ink-2 hover:text-ink hover:bg-panel-2',
  risk: 'bg-risk text-white hover:opacity-90',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] rounded-md',
  md: 'h-9 px-4 text-sm rounded-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(base, variants[variant], sizes[size], className)} {...props} />
  ),
);
Button.displayName = 'Button';
