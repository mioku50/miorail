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
    <div className={cn('flex items-center gap-1', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            'px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors duration-150',
            value === t.id
              ? 'bg-accent-soft text-accent-2'
              : 'text-ink-2 hover:text-ink hover:bg-panel-2',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
