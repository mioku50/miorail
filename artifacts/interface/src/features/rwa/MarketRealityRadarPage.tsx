import { useLocation } from 'wouter';
import { MarketRealityRadarScreen, useRadarConsoleV1 } from '@mioagent/ui';
import { useStatus } from '@mioagent/api-client-react';

// Phase 12.2 — Radar, on the web. Phase 15.1 moved the reads and the view into
// `useRadarConsoleV1`, which the Base App mounts too; a URL, a shell and a
// header are what is left that is genuinely the web's.

/** Radar, as a section of Watch: the exact market watches and what changed. */
export function RadarSection() {
  const [, navigate] = useLocation();
  const status = useStatus();
  const enabled = status.data?.productMigration?.routeIntelligenceV1 === true;

  const radar = useRadarConsoleV1({
    enabled,
    configurationRead: status.isSuccess,
    onOpenMarket: (question) => {
      const query = new URLSearchParams({
        key: question.underlyingKey ?? '',
        direction: question.direction,
        size: question.requestedCashAtomic,
        destination: question.destination,
      });
      navigate(`/market?${query.toString()}`);
    },
  });

  return <MarketRealityRadarScreen model={radar.model} />;
}
