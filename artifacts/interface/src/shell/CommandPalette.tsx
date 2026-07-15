import { useEffect } from 'react';
import { Command } from 'cmdk';
import { useLocation } from 'wouter';
import { useUiStore } from '../lib/state';
import { useStatus } from '@mioagent/api-client-react';
import { commandsForRouteIntelligence } from '../app/routes';

// cmdk-powered palette. Commands are generated from the route table (app/routes.tsx).
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const [, navigate] = useLocation();
  const { data } = useStatus();
  const commands = commandsForRouteIntelligence(data?.productMigration.routeIntelligenceV1 === true);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setPaletteOpen]);

  if (!open) return null;

  const run = (path: string) => {
    navigate(path);
    setPaletteOpen(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[3px] flex justify-center pt-[14vh] z-50" onClick={() => setPaletteOpen(false)}>
      <div className="w-[560px] bg-panel rounded-[18px] shadow-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <Command label="Command Palette">
          <Command.Input
            placeholder="Command or search... 'swap', 'scanner', 'positions'"
            className="w-full border-none outline-none px-[20px] py-[18px] text-[16px] border-b border-line bg-transparent text-ink"
            autoFocus
          />
          <Command.List className="max-h-[340px] overflow-y-auto p-2">
            <Command.Empty className="px-[13px] py-[11px] text-[14px] text-ink-3">No commands</Command.Empty>
            {commands.map((cmd) => (
              <Command.Item
                key={cmd.id}
                onSelect={() => run(cmd.path)}
                className="flex items-center gap-[12px] px-[13px] py-[11px] rounded-[11px] text-[14px] cursor-pointer text-ink data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent"
              >
                <span className="w-[28px] h-[28px] rounded-[8px] bg-bg flex items-center justify-center text-[14px]">{cmd.icon}</span>
                {cmd.label}
              </Command.Item>
            ))}
          </Command.List>
          <div className="px-[16px] py-[9px] border-t border-line text-[11px] text-ink-3 flex gap-[14px] font-mono">
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>esc to close</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
