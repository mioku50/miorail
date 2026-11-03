import { useRoute } from 'wouter';
import { useStillSpendShareV1 } from '@mioagent/api-client-react';
import { StillFrame, StillLoanShared, StillSpendShared, loanShareViewV1, spendShareViewV1 } from '@mioagent/ui/still';
import { useStillSky } from './useStillSky';

/** A Still Spend purchase or a loan someone shared: public, read from its signed
 * link alone. The server answers what the link claims, or that it signed no such link. */
export function StillSpendSharePage() {
  const [, params] = useRoute('/spend/p/:token');
  const token = params?.token ?? null;
  const sky = useStillSky();
  const share = useStillSpendShareV1(token);
  const view = share.data !== undefined ? spendShareViewV1(share.data) : null;
  const loan = share.data !== undefined && !view ? loanShareViewV1(share.data) : null;
  const cardUrl = token ? `/api/public/still/spend-card.png?t=${encodeURIComponent(token)}` : null;
  return (
    <StillFrame tab="more" sky={sky}>
      {loan ? <StillLoanShared sky={sky} view={loan} cardUrl={cardUrl} />
        : <StillSpendShared sky={sky} view={view} reading={token !== null && share.isPending} cardUrl={view ? cardUrl : null} />}
    </StillFrame>
  );
}
