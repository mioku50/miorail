import { useRoute } from 'wouter';
import { useStillSpendShareV1 } from '@mioagent/api-client-react';
import { StillFrame, StillSpendShared, spendShareViewV1 } from '@mioagent/ui/still';
import { useStillSky } from './useStillSky';

/** A Still Spend purchase someone shared: public, read from its signed link
 * alone. The server answers what the link claims, or that it signed no such link. */
export function StillSpendSharePage() {
  const [, params] = useRoute('/spend/p/:token');
  const token = params?.token ?? null;
  const sky = useStillSky();
  const share = useStillSpendShareV1(token);
  const view = share.data !== undefined ? spendShareViewV1(share.data) : null;
  return (
    <StillFrame tab="more" sky={sky}>
      <StillSpendShared sky={sky} view={view} reading={token !== null && share.isPending}
        cardUrl={token && view ? `/api/public/still/spend-card.png?t=${encodeURIComponent(token)}` : null} />
    </StillFrame>
  );
}
