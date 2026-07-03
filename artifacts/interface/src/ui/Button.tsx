import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'risk';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-2',
  secondary: 'bg-panel-2 text-ink border border-line hover:border-ink-3',
  ghost: 'text-ink-2 hover:text-ink hover:bg-panel-2',
  risk: 'bg-risk text-white hover:opacity-90',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-4 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(base, variants[variant], sizes[size], className)} {...props} />
  ),
);
Button.displayName = 'Button';
