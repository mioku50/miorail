import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useCreateStillSpendOrderV1, useStillMine, useStillSpendProductV1, useStillSpendSearchV1, useStillUsdcV1 } from '@mioagent/api-client-react';
import {
  StillFrame,
  StillSpend,
  spendCountryDefaultV1,
  spendOrderErrorV1,
  spendOrderViewV1,
  spendOwedCentsV1,
  spendPayOpenV1,
  spendProductViewV1,
  spendSearchViewV1,
  spendUsdcTextV1,
  type SpendGiftCategoryV1,
  type SpendTypeV1,
} from '@mioagent/ui/still';
import { useStillSky, useStillWallet } from './useStillSky';

/** Still Spend: Bitrefill's catalogue in USDC beside the reader's own Still
 * room and the USDC already in their wallet. Where the server pays Bitrefill, a
 * price opens one invoice, then the Get money page for a loan of exactly that
 * price or the wallet payment's page; nothing is paid here. */
export function StillSpendPage() {
  const [location, navigate] = useLocation();
  const sky = useStillSky(), session = useStillWallet();
  const mine = useStillMine(session.wallet, { enabled: session.signedIn });
  const usdc = useStillUsdcV1(session.wallet, { enabled: session.signedIn });
  const [type, setType] = useState<SpendTypeV1>('esim');
  const [country, setCountry] = useState(() => spendCountryDefaultV1(typeof navigator === 'undefined' ? undefined : navigator.language));
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [category, setCategory] = useState<SpendGiftCategoryV1 | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const [method, setMethod] = useState<'loan' | 'wallet'>('loan');
  // Gift cards are searched by brand or by one of Bitrefill's categories when the person asks; data and top-ups list at once.
  const search = useStillSpendSearchV1({ type, country, query: type === 'giftcard' ? asked : '', category: type === 'giftcard' ? category : null });
  const product = useStillSpendProductV1(selected);
  const order = useCreateStillSpendOrderV1();
  const room = mine.data?.headline.availableCents != null ? { cents: mine.data.headline.availableCents, complete: mine.data.headline.complete } : null;
  const results = useMemo(() => search.data !== undefined ? spendSearchViewV1(search.data) : null, [search.data]);
  const walletAtomic = usdc.data?.raw ?? null;
  const detail = useMemo(() => product.data !== undefined ? spendProductViewV1(product.data, room, walletAtomic) : null, [product.data, room?.cents, room?.complete, walletAtomic]);
  const productError = product.error
    ? /\b404\b/.test(product.error.message) ? 'Bitrefill does not offer this product now.' : 'This product could not be read from Bitrefill just now.'
    : detail?.error ?? null;
  const payOpen = session.signedIn && (spendPayOpenV1(product.data) || spendPayOpenV1(search.data));
  const pick = (next: string | null) => { setChosen(next); setPayError(null); };

  const onCreate = async (paidWith: 'loan' | 'wallet') => {
    const view = detail?.product;
    if (!view || chosen === null || order.isPending) return;
    setPayError(null); setMethod(paidWith);
    try {
      // A number goes only with a top-up, never with anything else the person picked after typing it.
      const opened = spendOrderViewV1(await order.mutateAsync({ productId: view.id, packageValue: chosen, email: email.trim(), ...(view.phone ? { phone: phone.trim() } : {}) }));
      if (!opened) { setPayError(spendOrderErrorV1('unreadable')); return; }
      navigate(paidWith === 'wallet' ? `/spend/pay/${opened.orderId}` : `/borrow?spend=${opened.orderId}`);
    } catch (error) {
      setPayError(spendOrderErrorV1(error instanceof Error ? error.message : ''));
    }
  };

  return (
    <StillFrame tab="more" sky={sky}>
      <StillSpend model={{
        sky, signedIn: session.signedIn, signInHref: `/signin?next=${encodeURIComponent(location)}`,
        type, onType: (next) => { setType(next); setSelected(null); pick(null); },
        country, onCountry: (next) => { setCountry(next); setSelected(null); pick(null); },
        query, onQuery: setQuery, onSearch: () => { setAsked(query.trim()); setCategory(null); setSelected(null); pick(null); },
        // A category replaces the brand searched for, and a brand replaces the category.
        category, onCategory: (next) => { setCategory(next); setQuery(''); setAsked(''); setSelected(null); pick(null); },
        searching: search.isFetching,
        products: results?.products ?? null,
        searchError: search.error ? 'Bitrefill’s catalogue could not be read just now. Try again in a minute.' : results?.error ?? null,
        selected, onSelect: (id) => { setSelected(id); pick(null); },
        product: detail?.product ?? null, productLoading: product.isFetching, productError,
        room, owedCents: spendOwedCentsV1(mine.data), walletUsdc: walletAtomic !== null ? spendUsdcTextV1(walletAtomic) : null,
        payAfterSignIn: !session.signedIn && (spendPayOpenV1(product.data) || spendPayOpenV1(search.data)),
        pay: payOpen ? {
          chosen, onChoose: pick, email, onEmail: (next) => { setEmail(next); setPayError(null); },
          phone, onPhone: (next) => { setPhone(next); setPayError(null); },
          creating: order.isPending, creatingWith: method, error: payError, onCreate: (paidWith) => void onCreate(paidWith),
        } : null,
      }} />
    </StillFrame>
  );
}
