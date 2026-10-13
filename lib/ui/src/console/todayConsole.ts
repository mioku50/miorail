import { useMemo, useState } from 'react';
import {
  useB20Watchlist,
  useMarketRealityRadar,
  useMeasureMyStockCashOut,
  useMyStocksToday,
  usePortfolio,
  useRwaUnderlyings,
} from '@mioagent/api-client-react';
import { underlyingChoicesV1 } from './marketRealityView';
import { marketRealityRadarViewV1 } from './marketRealityRadarView';
import { myStocksTodayModelV1 } from './stocksConsole';
import type { TodayScreenModelV1 } from './TodayScreen';
import {
  TODAY_UNROUTED_REPLY_V1,
  todayModelV1,
  todayWalletCheckV1,
  type TodayRouteV1,
} from './todayView';

// ---------------------------------------------------------------------------
// Today's reads, shared by every surface that mounts it.
//
// Every read here is one another page already makes: the balances B20
// controls shows, the watches Radar shows, the holder's card Stocks shows.
// Today only puts them first. Where a question goes is the surface's call,
// because the web has paths and Base App has sections.
// ---------------------------------------------------------------------------

export interface TodayConsoleInputV1 {
  /** A proven session. Until then the page is the public check. */
  signedIn: boolean;
  /** The connected wallet, whose balances are read. */
  address: string | null;
  /** Server flags, which are only read once a session exists. */
  stocksOn: boolean;
  b20On: boolean;
  actions: {
    onRoute: (route: Exclude<TodayRouteV1, { kind: 'unknown' }>) => void;
    onInvestigate: (tokenAddress: string) => void;
    onOpenRadar: () => void;
    onOpenB20: () => void;
    onAskWallet: (question: string) => void;
    onOpenStock: (symbol: string) => void;
    onSignIn: () => void;
  };
}

export function useTodayConsoleV1(input: TodayConsoleInputV1): TodayScreenModelV1 {
  const { signedIn, actions } = input;
  const stocksOn = !signedIn || input.stocksOn;
  const index = useRwaUnderlyings({ enabled: stocksOn, access: signedIn ? 'session' : 'public' });
  const portfolio = usePortfolio(signedIn ? (input.address ?? undefined) : undefined);
  const radar = useMarketRealityRadar({ enabled: signedIn && input.stocksOn });
  const watchlist = useB20Watchlist({ enabled: signedIn && input.b20On });
  const todayRead = useMyStocksToday({ enabled: signedIn && input.stocksOn });
  const cashOut = useMeasureMyStockCashOut();
  const [question, setQuestion] = useState('');
  const [reply, setReply] = useState<string | null>(null);

  const stocks = useMemo(
    () =>
      (index.data?.entries ?? []).flatMap((entry) =>
        entry.displaySymbol ? [{ symbol: entry.displaySymbol, name: entry.canonicalName }] : [],
      ),
    [index.data],
  );
  const choices = useMemo(() => underlyingChoicesV1(index.data ?? null), [index.data]);
  const radarView = useMemo(
    () =>
      radar.data
        ? marketRealityRadarViewV1({ wire: radar.data, choices, now: radar.data.assembledAt })
        : null,
    [radar.data, choices],
  );
  const check = useMemo(
    () => (portfolio.data ? todayWalletCheckV1(portfolio.data.tokens ?? []) : null),
    [portfolio.data],
  );

  const model = todayModelV1({
    signedIn,
    wallet: signedIn
      ? {
          check,
          loading: portfolio.isPending && Boolean(input.address),
          failed: Boolean(portfolio.error),
          radar: radarView,
          trackedB20: watchlist.data?.tokens.length ?? null,
        }
      : null,
    question,
    reply,
    stocks,
    actions: {
      ...actions,
      onQuestionChange: (value) => {
        setQuestion(value);
        setReply(null);
      },
      onRoute: (route) => {
        if (route.kind === 'unknown') {
          setReply(TODAY_UNROUTED_REPLY_V1);
          return;
        }
        setReply(null);
        actions.onRoute(route);
      },
    },
  });

  return {
    ...model,
    stocksToday: signedIn && input.stocksOn ? myStocksTodayModelV1(todayRead, cashOut) : null,
  };
}
