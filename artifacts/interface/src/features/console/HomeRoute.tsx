import { Redirect } from 'wouter';
import { useAccount } from 'wagmi';
import {
  consoleHomeSectionV1,
  consoleSectionPathV1,
  type ConsolePipelineStateV1,
} from '@mioagent/ui';
import { useB20Opportunities, useStatus } from '@mioagent/api-client-react';

// ---------------------------------------------------------------------------
// T70 §1 — where "/" goes.
//
// Opportunities is home, but only when there is something there. Sending every
// user to a screen that says "No opportunities" because a worker was never
// scheduled would be worse than the old default, not better — so the pipeline
// decides:
//
//   * healthy, catching up, waiting to measure, degraded → Opportunities, which
//     shows the pipeline's own sentence above whatever cards exist;
//   * not configured, storage down, decoder mismatch, unreachable → Portfolio
//     if a wallet is connected, otherwise Routes. Both work without Discover.
//
// The decision is made once, here, and the result is a real URL. That is what
// makes the section survive a refresh, a wallet reconnect, a trip through
// Review and the drawer opening — none of which this app can control, and all
// of which a URL already handles.
// ---------------------------------------------------------------------------

export function HomeRoute() {
  const { address } = useAccount();
  const status = useStatus();
  const discoverOn = status.data?.productMigration?.b20ControlV1 === true;

  // Not asked at all when the flag is off: the endpoint would refuse, and
  // spending a round trip to be told what the status response already said is
  // just a slower redirect.
  const feed = useB20Opportunities(undefined, { enabled: discoverOn });

  const resolving = status.isPending || (discoverOn && feed.isPending);
  if (resolving) {
    // Deliberately quiet. A spinner here would be the first thing every user
    // sees on every cold load, for a decision that resolves in one request.
    return <div className="mio-console app" />;
  }

  const pipeline = feed.data?.pipeline ?? null;
  const home = consoleHomeSectionV1({
    pipeline:
      discoverOn && pipeline
        ? { state: pipeline.state as ConsolePipelineStateV1, message: pipeline.message }
        : null,
    observationCount: feed.data?.cards.length ?? 0,
    walletConnected: Boolean(address),
  });

  // The query string travels with the redirect. It used to be dropped, which
  // is half of why "Swap this token" appeared to do nothing: the goal was put
  // on `/`, and `/` is this — a route whose only job is to send you somewhere
  // else. Nothing here reads the query; it is carried so the destination can.
  return <Redirect to={`${consoleSectionPathV1(home.section)}${window.location.search}`} replace />;
}
