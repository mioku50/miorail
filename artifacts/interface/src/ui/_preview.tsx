// F1 dev-only preview of the ui/ primitives. Visit ?dev=ui to inspect them and
// toggle dark/light. Removed when F2 wires the primitives into real views.
import { useState } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { Badge } from './Badge';
import { StateBadge, type StateKind } from './StateBadge';
import { Switch } from './Switch';
import { Dialog } from './Dialog';
import { Tooltip } from './Tooltip';
import { Tabs } from './Tabs';
import { Kbd } from './Kbd';
import { useTheme } from '../theme/ThemeProvider';

const SECTION = 'text-[11px] font-mono uppercase tracking-[0.08em] text-ink-3';
const STATES: StateKind[] = ['live', 'cached', 'stale', 'mock', 'disconnected', 'missing', 'disabled', 'failed'];

export function UiPreview() {
  const { theme, toggle } = useTheme();
  const [sw, setSw] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [tab, setTab] = useState('a');

  return (
    <div className="h-screen overflow-y-auto bg-bg p-8 text-ink">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">MioAgent · ui/ primitives</h1>
          <Button variant="secondary" size="sm" onClick={toggle}>
            theme: {theme}
          </Button>
        </header>

        <Card className="space-y-3 p-4">
          <h2 className={SECTION}>Buttons</h2>
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="risk">Risk</Button>
            <Button disabled>Disabled</Button>
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className={SECTION}>Badges</h2>
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">neutral</Badge>
            <Badge tone="accent">accent</Badge>
            <Badge tone="ok">ok</Badge>
            <Badge tone="warn">warn</Badge>
            <Badge tone="risk">risk</Badge>
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className={SECTION}>StateBadges</h2>
          <div className="flex flex-wrap gap-2">
            {STATES.map((s) => (
              <StateBadge key={s} state={s} />
            ))}
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className={SECTION}>Controls</h2>
          <div className="flex items-center gap-4">
            <Switch checked={sw} onCheckedChange={setSw} />
            <span className="text-sm text-ink-2">{sw ? 'on' : 'off'}</span>
            <Tooltip content="Open the command palette">
              <Kbd>⌘K</Kbd>
            </Tooltip>
          </div>
          <Tabs
            tabs={[
              { id: 'a', label: 'First' },
              { id: 'b', label: 'Second' },
              { id: 'c', label: 'Third' },
            ]}
            value={tab}
            onChange={setTab}
          />
          <Button variant="secondary" size="sm" onClick={() => setDialog(true)}>
            Open dialog
          </Button>
          <Dialog open={dialog} onOpenChange={setDialog} title="Example dialog">
            <p className="text-sm text-ink-2">Dialog body — Escape or click the scrim to close.</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDialog(false)}>
                Close
              </Button>
            </div>
          </Dialog>
        </Card>
      </div>
    </div>
  );
}
