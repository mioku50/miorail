import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useStillMine, useStillSpendProductV1, useStillSpendSearchV1 } from '@mioagent/api-client-react';
import { StillFrame, StillSpend, spendCountryDefaultV1, spendProductViewV1, spendSearchViewV1, type SpendTypeV1 } from '@mioagent/ui/still';
import { useStillSky, useStillWallet } from './useStillSky';

/** Still Spend, stage 1: Bitrefill's catalogue in USDC beside the reader's own Still room. Nothing is bought here. */
export function StillSpendPage() {
  const [location] = useLocation();
  const sky = useStillSky(), session = useStillWallet();
  const mine = useStillMine(session.wallet, { enabled: session.signedIn });
  const [type, setType] = useState<SpendTypeV1>('esim');
  const [country, setCountry] = useState(() => spendCountryDefaultV1(typeof navigator === 'undefined' ? undefined : navigator.language));
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  // Gift cards are searched by brand when the person asks; data and top-ups list at once.
  const search = useStillSpendSearchV1({ type, country, query: type === 'giftcard' ? asked : '' });
  const product = useStillSpendProductV1(selected);
  const room = mine.data?.headline.availableCents != null ? { cents: mine.data.headline.availableCents, complete: mine.data.headline.complete } : null;
  const results = useMemo(() => search.data !== undefined ? spendSearchViewV1(search.data) : null, [search.data]);
  const detail = useMemo(() => product.data !== undefined ? spendProductViewV1(product.data, room) : null, [product.data, room?.cents, room?.complete]);
  const productError = product.error
    ? /\b404\b/.test(product.error.message) ? 'Bitrefill does not offer this product now.' : 'This product could not be read from Bitrefill just now.'
    : detail?.error ?? null;
  return (
    <StillFrame tab="more" sky={sky}>
      <StillSpend model={{
        sky, signedIn: session.signedIn, signInHref: `/signin?next=${encodeURIComponent(location)}`,
        type, onType: (next) => { setType(next); setSelected(null); },
        country, onCountry: (next) => { setCountry(next); setSelected(null); },
        query, onQuery: setQuery, onSearch: () => { setAsked(query.trim()); setSelected(null); },
        searching: search.isFetching,
        products: results?.products ?? null,
        searchError: search.error ? 'Bitrefill’s catalogue could not be read just now. Try again in a minute.' : results?.error ?? null,
        selected, onSelect: setSelected,
        product: detail?.product ?? null, productLoading: product.isFetching, productError,
        room,
      }} />
    </StillFrame>
  );
}
