import { type ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem {
  id: string;
  label: ReactNode;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, value, onChange, className }: TabsProps) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-line', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            'border-b-2 px-3 py-2 text-[13px] transition-colors',
            value === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
