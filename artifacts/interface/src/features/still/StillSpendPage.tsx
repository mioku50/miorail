import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useCreateStillSpendOrderV1, useStillLoopsV1, useStillMine, useStillSpendProductV1, useStillSpendSearchV1, useStillSpendStatusV1, useStillUsdcV1 } from '@mioagent/api-client-react';
import {
  StillFrame,
  StillSpend,
  spendCountryDefaultV1,
  spendOrderErrorV1,
  spendOrderViewV1,
  spendOwedCentsV1,
  spendPayStateV1,
  spendProductViewV1,
  spendSearchViewV1,
  spendUsdcTextV1,
  loopBrandByIdV1,
  loopBrandProductsV1,
  STILL_SUBSCRIPTIONS_V1,
  stillSubscriptionProductsV1,
  stillSubscriptionStoreRoutesV1,
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
  // /subscriptions opens on them: a link a post can carry, with or without a slash after it.
  const startsOnSubscriptions = location.replace(/\/+$/, '') === '/subscriptions';
  // /spend?card=apple, from /loops: that brand's own cards in the reader's country, and its stock ready for the loan.
  const [loop, setLoop] = useState(() => loopBrandByIdV1(typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('card')));
  // Null while Loops are off here, undefined until read: either way, nothing promises a Loop (audit SPEND-4).
  const loopsOn = useStillLoopsV1({ poll: false }).data != null;
  const [type, setType] = useState<SpendTypeV1>(startsOnSubscriptions || loop ? 'giftcard' : 'esim');
  const [country, setCountry] = useState(() => spendCountryDefaultV1(typeof navigator === 'undefined' ? undefined : navigator.language));
  const [query, setQuery] = useState(loop?.search ?? '');
  const [asked, setAsked] = useState(loop?.search ?? '');
  const [category, setCategory] = useState<SpendGiftCategoryV1 | null>(null);
  // Subscriptions: the list open, and the service whose cards are searched for (lib/still-engine/src/subscriptions.ts).
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(startsOnSubscriptions);
  const [service, setService] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const [method, setMethod] = useState<'loan' | 'wallet'>('loan');
  // Gift cards are searched by brand or by one of Bitrefill's categories when the person asks; data and top-ups list at once.
  // The subscriptions list itself reads nothing from Bitrefill: a search starts when a service is chosen.
  const search = useStillSpendSearchV1(subscriptionsOpen && !service ? null
    : { type, country, query: type === 'giftcard' ? asked : '', category: type === 'giftcard' ? category : null });
  const product = useStillSpendProductV1(selected);
  const order = useCreateStillSpendOrderV1();
  const room = mine.data?.headline.availableCents != null ? { cents: mine.data.headline.availableCents, complete: mine.data.headline.complete } : null;
  const results = useMemo(() => search.data !== undefined ? spendSearchViewV1(search.data) : null, [search.data]);
  // A service's search keeps only that service's cards: "Disney" also finds a park ticket, "Xbox" a game's points.
  const listed = results?.products && subscriptionsOpen && service ? stillSubscriptionProductsV1(service, results.products)
    // A brand's word finds other stores too ("Xbox": Kinguin, G2A, a game's points): only its own cards make a Loop.
    : results?.products && loop ? loopBrandProductsV1(loop.brand, results.products) : results?.products ?? null;
  // A service's own card missing for this country: the app store cards that pay its plan bought inside its app are
  // read then, and only then, by the search the store's own tile runs (cached alike, so pressing it shows them at once).
  const routeTiles = subscriptionsOpen && service && !search.isFetching && listed?.length === 0 ? stillSubscriptionStoreRoutesV1(service) : [];
  const appleTile = routeTiles.find((row) => row.store === 'apple') ?? null;
  const googleTile = routeTiles.find((row) => row.store === 'google') ?? null;
  const appleRead = useStillSpendSearchV1(appleTile ? { type: 'giftcard', country, query: appleTile.search, category: null } : null);
  const googleRead = useStillSpendSearchV1(googleTile ? { type: 'giftcard', country, query: googleTile.search, category: null } : null);
  const storeRoutes = ([[appleTile, appleRead.data], [googleTile, googleRead.data]] as const).flatMap(([tile, data]) => {
    if (!tile?.store || data === undefined) return [];
    const found = spendSearchViewV1(data).products;
    return found && stillSubscriptionProductsV1(tile.key, found).length > 0 ? [tile.store] : [];
  });
  const walletAtomic = usdc.data?.raw ?? null;
  const detail = useMemo(() => product.data !== undefined ? spendProductViewV1(product.data, room, walletAtomic) : null, [product.data, room?.cents, room?.complete, walletAtomic]);
  const productError = product.error
    ? /\b404\b/.test(product.error.message) ? 'Bitrefill does not offer this product now.' : 'This product could not be read from Bitrefill just now.'
    : detail?.error ?? null;
  // The server's own switch, from its own answer alone: a search or a product read earlier says what the switch was
  // then, and a fresh "off" is not outweighed by an older "on". Until it answers the page says it is checking, and
  // when it cannot be read, that it could not check; neither is "closed".
  const status = useStillSpendStatusV1();
  const payState = spendPayStateV1(status.data, { pending: status.data === undefined && !status.isError });
  const payOn = payState === 'on';
  const payOpen = session.signedIn && payOn;
  const pick = (next: string | null) => { setChosen(next); setPayError(null); };

  const onCreate = async (paidWith: 'loan' | 'wallet') => {
    const view = detail?.product;
    if (!view || chosen === null || order.isPending) return;
    setPayError(null); setMethod(paidWith);
    try {
      // A number goes only with a top-up, never with anything else the person picked after typing it.
      const opened = spendOrderViewV1(await order.mutateAsync({ productId: view.id, packageValue: chosen, email: email.trim(), ...(view.phone ? { phone: phone.trim() } : {}) }));
      if (!opened) { setPayError(spendOrderErrorV1('unreadable')); return; }
      // A brand's own card paid with a loan: its stock is the one the loan page offers first.
      const pledge = loop && loopBrandProductsV1(loop.brand, [view]).length === 1 ? `&asset=${loop.collateral}` : '';
      navigate(paidWith === 'wallet' ? `/spend/pay/${opened.orderId}` : `/borrow?spend=${opened.orderId}${pledge}`);
    } catch (error) {
      setPayError(spendOrderErrorV1(error instanceof Error ? error.message : ''));
    }
  };

  return (
    <StillFrame tab="more" sky={sky} entry>
      <StillSpend model={{
        sky, signedIn: session.signedIn, signInHref: `/signin?next=${encodeURIComponent(location)}`,
        type, onType: (next) => { setType(next); setLoop(null); setSubscriptionsOpen(false); setService(null); setSelected(null); pick(null); },
        country, onCountry: (next) => { setCountry(next); setSelected(null); pick(null); },
        query, onQuery: setQuery,
        // Another word is another search: the brand's own cards only for the word the link searched.
        onSearch: () => { setAsked(query.trim()); setLoop(loop && query.trim() === loop.search ? loop : null); setCategory(null); setSubscriptionsOpen(false); setService(null); setSelected(null); pick(null); },
        // A category replaces the brand searched for, and a brand replaces the category; either closes the subscriptions.
        category, onCategory: (next) => { setCategory(next); setLoop(null); setQuery(''); setAsked(''); setSubscriptionsOpen(false); setService(null); setSelected(null); pick(null); },
        subscriptions: {
          open: subscriptionsOpen, chosen: service, storeRoutes,
          onOpen: (open) => {
            if (open) setType('giftcard');
            setSubscriptionsOpen(open); setLoop(null); setService(null); setCategory(null); setQuery(''); setAsked(''); setSelected(null); pick(null);
          },
          onChoose: (key) => {
            const chosen = STILL_SUBSCRIPTIONS_V1.find((row) => row.key === key);
            if (!chosen) return;
            setService(key); setCategory(null); setQuery(''); setAsked(chosen.search); setSelected(null); pick(null);
          },
        },
        loop: loop ? { name: loop.name, card: loop.card, collateral: loop.collateral, makesLoop: loopsOn } : null,
        searching: search.isFetching,
        // Nothing listed while the subscriptions are open and no service is chosen yet.
        products: subscriptionsOpen && !service ? null : listed,
        searchError: search.error ? 'Bitrefill’s catalogue could not be read just now. Try again in a minute.' : results?.error ?? null,
        selected, onSelect: (id) => { setSelected(id); pick(null); },
        product: detail?.product ?? null, productLoading: product.isFetching, productError,
        room, owedCents: spendOwedCentsV1(mine.data), walletUsdc: walletAtomic !== null ? spendUsdcTextV1(walletAtomic) : null,
        payAfterSignIn: !session.signedIn && payOn,
        ...(payState === 'checking' || payState === 'unknown' ? { payState } : {}),
        pay: payOpen ? {
          chosen, onChoose: pick, email, onEmail: (next) => { setEmail(next); setPayError(null); },
          phone, onPhone: (next) => { setPhone(next); setPayError(null); },
          creating: order.isPending, creatingWith: method, error: payError, onCreate: (paidWith) => void onCreate(paidWith),
        } : null,
      }} />
    </StillFrame>
  );
}
