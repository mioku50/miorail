import { useEffect } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useAccount } from 'wagmi';
import {
  ConsoleShell,
  chainBlockNumberV1,
  chainGasLabelV1,
  chainLabelV1,
  chainUnavailableReasonV1,
  consoleSectionPathV1,
  useConsoleTheme,
} from '@mioagent/ui';
import { useStatus } from '@mioagent/api-client-react';
import { useConsoleNav } from '../console/useConsoleNav';
import { B20WatchSection } from '../b20/B20WatchPage';
import { InvestigateSection } from '../rwa/InvestigatePage';
import { RadarSection } from '../rwa/MarketRealityRadarPage';

// ---------------------------------------------------------------------------
// Watch: Investigate, B20 controls and Radar on one page.
//
// Each was a page of its own and each, alone, was half empty: a search box, a
// list of the tokens you hold, a list of markets you watch. They answer one
// question from three sides (what could happen to what I hold), so they are
// read together: any address first, then your tokens, then your markets.
//
// The old addresses still work. /investigate, /portfolio and /radar redirect
// here with their query and a hash naming the section, and a `?token=` is
// read by the section the hash names, so a link from Discover lands where it
// pointed.
// ---------------------------------------------------------------------------

const WATCH_SECTIONS_V1 = [
  { id: 'investigate', label: 'Any address' },
  { id: 'tokens', label: 'Your tokens' },
  { id: 'radar', label: 'Your markets' },
] as const;

function shortAddressV1(address: string | undefined): string | null {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;
}

export function WatchPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { address } = useAccount();
  const { theme, setTheme } = useConsoleTheme();
  const status = useStatus();
  const nav = useConsoleNav('portfolio');

  // A redirect or a link names a section in the hash: bring it into view once
  // the page has drawn, as the browser would for a static anchor.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!WATCH_SECTIONS_V1.some((section) => section.id === id)) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(`watch-${id}`)?.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [search]);

  return (
    <ConsoleShell
      header={{
        crumb: ['Watch'],
        nav: nav.header,
        onNavigate: nav.navigate,
        blockNumber: chainBlockNumberV1(status.data ?? null),
        gasLabel: chainGasLabelV1(status.data ?? null),
        chainUnavailableReason: chainUnavailableReasonV1(status.data ?? null),
        networkLabel: chainLabelV1(status.data?.chainId),
        connected: Boolean(address) && status.data?.rpc?.status === 'connected',
        walletLabel: shortAddressV1(address),
      }}
      left={{
        nav: nav.rail,
        sessions: [],
        sessionCount: '0',
        proofs: [],
        proofCount: '0',
        onOpenSettings: () => nav.navigate('settings'),
      }}
      footer={{
        adaptersLabel: '—',
        sourcesLabel: '—',
        spendLabel: '$0',
        blockNumber: chainBlockNumberV1(status.data ?? null),
      }}
      right={null}
      theme={theme}
      onThemeChange={setTheme}
      onNewGoal={() => navigate(consoleSectionPathV1('routes'))}
      onSelectSession={() => navigate(consoleSectionPathV1('routes'))}
      onSelectProof={() => navigate(consoleSectionPathV1('activity'))}
    >
      <div className="watch-page">
        {/* A div, not a header: the console styles its own page header. */}
        <div className="watch-intro">
          <p className="lnote">
            What could happen to what you hold, from three sides: any Base address read in full, what each issuer can do
            to the tokens you hold, and the exact markets you watch.
          </p>
          <nav className="watch-jump" aria-label="Sections">
            {WATCH_SECTIONS_V1.map((section) => (
              <a key={section.id} href={`#${section.id}`} onClick={(event) => {
                event.preventDefault();
                window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${section.id}`);
                document.getElementById(`watch-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}>
                {section.label}
              </a>
            ))}
          </nav>
        </div>
        <section id="watch-investigate" className="watch-section" aria-label="Any address">
          <h2 className="watch-title">Any address</h2>
          <InvestigateSection />
        </section>
        <section id="watch-tokens" className="watch-section" aria-label="Your tokens">
          <h2 className="watch-title">Your tokens</h2>
          <B20WatchSection />
        </section>
        <section id="watch-radar" className="watch-section" aria-label="Your markets">
          <h2 className="watch-title">Your markets</h2>
          <RadarSection />
        </section>
      </div>
    </ConsoleShell>
  );
}
