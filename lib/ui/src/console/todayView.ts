import { REVIEWED_DISCOVERY_ALIASES_V1 } from '@mioagent/rwa-market-reality/discovery-aliases';
import { routeFamilyForGoalV1 } from './consoleFlow';
import type { WalletBalanceEntryV1, WalletBalancesModelV1 } from './WalletBalancesCard';
import { trackedRowClocksV1, type B20TrackedTokenLikeV1, type TrackedRowClockV1 } from './B20WatchScreen';

// ---------------------------------------------------------------------------
// Today — the first screen, with the answers before the question.
//
// Five places in Miorail answered questions, and in two weeks none of them
// was asked one (nginx, 2026-09-29 → 10-13). Investigate was an empty field
// and Radar said "0 watched markets". Today leads with what is already known
// about a reader's wallet, and puts one line under it that hands a question
// to the screen that owns it.
//
// The line routes; it never answers. Each owner keeps its own sources,
// budgets and approvals, and nothing here reaches a model: one free agent
// over every tool would have dissolved exactly those boundaries.
// ---------------------------------------------------------------------------

export type TodayRouteV1 =
  /** An address anywhere in the text: the dossier answers "can I sell it". */
  | { kind: 'investigate'; tokenAddress: string }
  /** A stock the board knows, by ticker or by name: its card holds Ask and Buy. */
  | { kind: 'stock'; symbol: string; name: string }
  /** Rewards, fees, balances: what Wallet MCP's console answers. */
  | { kind: 'wallet'; question: string }
  /** A goal Swap AI's own dispatcher recognises. */
  | { kind: 'routes'; goal: string }
  | { kind: 'unknown' };

export interface TodayStockNameV1 {
  /** The board's display symbol, which is what `/stocks/:symbol` matches. */
  symbol: string;
  name: string;
  /**
   * Reviewed names a person types for a stock stored under its ticker alone:
   * "nvidia" for NVDA. Each is bound to the row's own ISIN, never to a ticker.
   */
  aliases?: readonly string[];
}

/**
 * The board's entries as names Today can recognise.
 *
 * Six of the most asked-about stocks (NVDA, TSLA, MSFT, GOOGL, GME, MSTR) are
 * stored with the ticker as their name, so "Nvidia" matched nothing while
 * "Apple" found AAPL (production, 2026-10-17). Discovery already keeps a
 * reviewed alias list for exactly those rows; an alias attaches only where the
 * entry's own identifier is the ISIN it was reviewed for.
 */
export function todayStockNamesV1(
  entries: readonly {
    displaySymbol: string | null;
    canonicalName: string;
    identifierScheme: string | null;
    identifierValue: string | null;
  }[],
): TodayStockNameV1[] {
  return entries.flatMap((entry) => {
    if (!entry.displaySymbol) return [];
    const isin = entry.identifierScheme?.toLowerCase() === 'isin' ? entry.identifierValue : null;
    const aliases = isin
      ? REVIEWED_DISCOVERY_ALIASES_V1.filter((alias) => alias.isin === isin).map((alias) => alias.name)
      : [];
    return [{ symbol: entry.displaySymbol, name: entry.canonicalName, ...(aliases.length > 0 ? { aliases } : {}) }];
  });
}

const ADDRESS_V1 = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
// `\b` is an ASCII boundary and never fires before Cyrillic, so the Russian
// stems are matched without it, as consoleFlow does.
const WALLET_PATTERN_V1 =
  /\b(claim|claimable|rewards?|collect|my wallet|my balances?|my holdings|what do i (?:hold|own|have))\b/i;
const WALLET_PATTERN_RU_V1 = /(наград|забрат|собрат|клейм|кошел|баланс|что у меня)/i;
// Legal-form words a company name carries and a person never types.
// Everything from the first comma, full stop or legal-form word onwards:
// "Apple Inc." is "Apple", "First Solar, Inc." is "First Solar".
const NAME_SUFFIX_V1 =
  /(?:[,.(]|\s(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|class|n\.?v|s\.?a|ag|se)\b).*$/i;

function coreNameV1(name: string): string {
  return name
    .replace(/^the\s+/i, '')
    .replace(NAME_SUFFIX_V1, '')
    .trim()
    .toLowerCase();
}

function escapeV1(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The stock a sentence names, or null.
 *
 * A ticker counts only when it is written as one, in capitals or after a `$`:
 * "all", "on" and "it" are English words and tickers both. A name counts when
 * its core ("Apple" for "Apple Inc.") appears as whole words and is at least
 * four letters long.
 */
export function stockNamedV1(
  text: string,
  stocks: readonly TodayStockNameV1[],
): TodayStockNameV1 | null {
  const words = text.split(/[^A-Za-z0-9$]+/).filter(Boolean);
  for (const stock of stocks) {
    const ticker = stock.symbol.toUpperCase();
    for (const word of words) {
      if (word.startsWith('$')) {
        const bare = word.slice(1).toUpperCase();
        if (bare === ticker || bare === `${ticker}C`) return stock;
      } else if (ticker.length >= 2 && (word === ticker || word === `${ticker}c`)) {
        // One capital letter is how a sentence starts, not a ticker: "A" is
        // Agilent only as "$A".
        return stock;
      }
    }
  }
  const lower = text.toLowerCase();
  for (const stock of stocks) {
    for (const name of [coreNameV1(stock.name), ...(stock.aliases ?? [])]) {
      if (name.length < 4) continue;
      if (new RegExp(`(^|[^a-z0-9])${escapeV1(name)}([^a-z0-9]|$)`).test(lower)) return stock;
    }
  }
  return null;
}

/** Where a question on Today goes. Deterministic, Russian and English alike. */
export function routeTodayQuestionV1(
  text: string,
  stocks: readonly TodayStockNameV1[],
): TodayRouteV1 {
  const value = text.trim().slice(0, 500);
  if (!value) return { kind: 'unknown' };
  const address = ADDRESS_V1.exec(value)?.[0];
  if (address) return { kind: 'investigate', tokenAddress: address.toLowerCase() };
  const stock = stockNamedV1(value, stocks);
  if (stock) return { kind: 'stock', symbol: stock.symbol, name: stock.name };
  if (WALLET_PATTERN_V1.test(value) || WALLET_PATTERN_RU_V1.test(value)) {
    return { kind: 'wallet', question: value };
  }
  if (routeFamilyForGoalV1(value, { includePrivateAi: false }) !== 'unknown') {
    return { kind: 'routes', goal: value };
  }
  return { kind: 'unknown' };
}

export interface TodayWalletTokenV1 {
  symbol: string;
  address: string;
  /** As the provider formatted it, in the token's own decimals. */
  balance: string | null;
}

export interface TodayWalletCheckV1 {
  /** Listed by their issuer at this exact address. */
  official: (TodayWalletTokenV1 & { ticker: string })[];
  /** Wearing an official ticker at another address. */
  lookalikes: (TodayWalletTokenV1 & { officialTicker: string })[];
  /**
   * Everything else the wallet holds that no list vouches for: not official,
   * not a known lookalike, not marked verified or spam by the provider. Not a
   * verdict — nobody has looked yet, and Investigate is where one looks.
   */
  unchecked: TodayWalletTokenV1[];
  /** The provider's spam heuristic, counted apart as the balances card does. */
  possibleSpam: number;
}

/**
 * What the wallet's balances already say, sorted into what a reader can act on.
 *
 * The registry mark wins over the spam flag: a contract wearing AAPLc's ticker
 * at another address is the finding, whatever a provider guessed about it.
 */
export function todayWalletCheckV1(rows: readonly WalletBalanceEntryV1[]): TodayWalletCheckV1 {
  const check: TodayWalletCheckV1 = { official: [], lookalikes: [], unchecked: [], possibleSpam: 0 };
  for (const row of rows) {
    const address = row.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    const amount = row.balanceFormatted == null || row.balanceFormatted.trim() === ''
      ? NaN : Number(row.balanceFormatted);
    // A balance the server could not format is still a holding.
    if (Number.isFinite(amount) && amount === 0) continue;
    const token = { symbol: row.symbol, address, balance: row.balanceFormatted ?? null };
    if (row.registry?.standing === 'official') {
      check.official.push({ ...token, ticker: row.registry.ticker });
    } else if (row.registry?.standing === 'lookalike') {
      check.lookalikes.push({ ...token, officialTicker: row.registry.ticker });
    } else if (row.possibleSpam === true) {
      check.possibleSpam += 1;
    } else if (row.verified !== true) {
      check.unchecked.push(token);
    }
  }
  const bySymbol = (left: TodayWalletTokenV1, right: TodayWalletTokenV1) =>
    left.symbol.localeCompare(right.symbol) || left.address.localeCompare(right.address);
  check.official.sort(bySymbol);
  check.lookalikes.sort(bySymbol);
  check.unchecked.sort(bySymbol);
  return check;
}

// ---------------------------------------------------------------------------
// The screen's model
// ---------------------------------------------------------------------------

export interface TodayTileV1 {
  label: string;
  value: string;
  /** Amber only where the number is a finding (colour-is-a-claim). */
  attention: boolean;
}

export interface TodayActionV1 {
  label: string;
  onClick: () => void;
}

export interface TodayItemV1 {
  key: string;
  title: string;
  body: string;
  attention: boolean;
  actions: TodayActionV1[];
  /** The controls and market clocks belong to this one exact address. */
  clocks?: readonly TrackedRowClockV1[];
}

export interface TodayModelV1 {
  /** Null for a reader with no session: they get the check, not a wallet. */
  wallet: {
    tiles: TodayTileV1[];
    items: TodayItemV1[];
    loading: boolean;
    /** Why the wallet could not be read. Never a claim about what it holds. */
    unavailable: string | null;
    /** Response assembly time, not a promise that cached balances were reread. */
    overviewUpdatedAt: string | null;
    dataFreshness: string | null;
    balances: WalletBalancesModelV1 | null;
    onInvestigate: (tokenAddress: string) => void;
  } | null;
  stockActions: {
    onOpenStock: (symbol: string) => void;
    onOpenDividends: (() => void) | null;
  };
  ask: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder: string;
    /** Each one names something this wallet has, so each one is servable. */
    suggestions: TodayActionV1[];
    reply: string | null;
  };
  onSignIn: (() => void) | null;
}

export interface TodayInputV1 {
  signedIn: boolean;
  wallet: {
    check: TodayWalletCheckV1 | null;
    loading: boolean;
    failed: boolean;
    overviewUpdatedAt?: string | null;
    dataFreshness?: string | null;
    /** Passed from the portfolio query already mounted by Today. */
    rows?: readonly WalletBalanceEntryV1[] | null;
    controlWatches?: readonly B20TrackedTokenLikeV1[];
    /** Radar's own projection, so a change reads here as it reads there. */
    radar: {
      watches: readonly unknown[];
      events: readonly { title: string; headline: string }[];
    } | null;
    trackedB20: number | null;
  } | null;
  question: string;
  now?: Date;
  reply: string | null;
  stocks: readonly TodayStockNameV1[];
  actions: {
    onQuestionChange: (value: string) => void;
    onRoute: (route: TodayRouteV1) => void;
    onInvestigate: (tokenAddress: string) => void;
    onOpenRadar: () => void;
    onOpenB20: () => void;
    onAskWallet: (question: string) => void;
    onOpenStock: (symbol: string) => void;
    onOpenDividends?: () => void;
    onSignIn: () => void;
  };
}

/** Wallet MCP's own example, which reads Aerodrome and Uniswap v3. */
export const TODAY_REWARDS_QUESTION_V1 = 'What can I claim?';

/** Said when a question names nothing a page here answers. */
export const TODAY_UNROUTED_REPLY_V1 =
  'Today hands a question to the page that answers it. Paste a token address, name a stock, ask what you can claim, or describe a swap.';

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function shortV1(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function todayModelV1(input: TodayInputV1): TodayModelV1 {
  const { actions } = input;
  const ask = {
    value: input.question,
    onChange: actions.onQuestionChange,
    onSubmit: () => actions.onRoute(routeTodayQuestionV1(input.question, input.stocks)),
    reply: input.reply,
  };
  if (!input.signedIn || !input.wallet) {
    return {
      wallet: null,
      stockActions: { onOpenStock: actions.onOpenStock, onOpenDividends: null },
      ask: { ...ask, placeholder: 'Paste a token address (0x…) or name a stock', suggestions: [] },
      onSignIn: actions.onSignIn,
    };
  }

  const { check, radar } = input.wallet;
  const items: TodayItemV1[] = [];
  for (const token of check?.lookalikes.slice(0, 3) ?? []) {
    items.push({
      key: `lookalike:${token.address}`,
      // A name matched and an address did not: that is the whole finding, in
      // words someone holding the token reads without a glossary.
      title: `Not the official ${token.officialTicker}`,
      body: `${token.balance ? `You hold ${token.balance} of a token named ${token.symbol}` : `A token named ${token.symbol}`} at ${shortV1(token.address)}. The official ${token.officialTicker} lives at a different address, so this is another token with the same name.`,
      attention: true,
      actions: [{ label: 'See the evidence', onClick: () => actions.onInvestigate(token.address) }],
    });
  }
  items.push({
    key: 'rewards',
    title: 'Rewards you may be able to claim',
    body: 'Wallet MCP reads Aerodrome and Uniswap v3 for this wallet. A claim is prepared for you to approve; nothing is sent without you.',
    attention: false,
    actions: [{ label: TODAY_REWARDS_QUESTION_V1, onClick: () => actions.onAskWallet(TODAY_REWARDS_QUESTION_V1) }],
  });
  if (check && check.unchecked.length > 0) {
    items.push({
      key: 'unchecked',
      title: `${plural(check.unchecked.length, 'token')} outside Miorail's reviewed coverage`,
      body: 'This is a coverage gap, not a risk finding. These addresses have no reviewed issuer match or completed verification in this overview. Check an address for its evidence.',
      attention: false,
      actions: check.unchecked.slice(0, 3).map((token) => ({
        label: `Check ${token.symbol}`,
        onClick: () => actions.onInvestigate(token.address),
      })),
    });
  }
  if (radar && radar.watches.length > 0) {
    const latest = radar.events[0];
    items.push({
      key: 'radar',
      title: `${plural(radar.watches.length, 'market')} under watch`,
      body: latest
        ? `Latest established change: ${latest.title}, ${latest.headline.toLowerCase()}.`
        : 'No change has been established since the first comparable reading.',
      attention: false,
      actions: [{ label: 'Open Radar', onClick: actions.onOpenRadar }],
    });
  } else if (radar && check && check.official.length > 0) {
    const held = check.official[0]!;
    const stock = stockNamedV1(held.ticker, input.stocks);
    items.push({
      key: 'radar-start',
      title: `Watch the market of ${held.ticker}`,
      body: `You hold ${held.ticker}. Radar says when what you would get back for it, or the route out, changes.`,
      attention: false,
      actions: stock ? [{ label: `Open ${stock.symbol}`, onClick: () => actions.onOpenStock(stock.symbol) }] : [],
    });
  }
  if ((input.wallet.trackedB20 ?? 0) > 0) {
    items.push({
      key: 'b20',
      title: `${plural(input.wallet.trackedB20!, 'B20 token')} tracked`,
      body: 'Market watches run in the background. Controls are read when you request them; their last read can be older than the market measurement.',
      attention: false,
      actions: [{ label: 'Open B20 controls', onClick: actions.onOpenB20 }],
    });
    for (const entry of input.wallet.controlWatches?.slice(0, 3) ?? []) {
      const held = input.wallet.rows?.find(row => row.address.toLowerCase() === entry.tokenAddress.toLowerCase());
      const reading = trackedRowClocksV1(entry, input.now ?? new Date());
      items.push({
        key: `b20:${entry.tokenAddress}`,
        title: `${held?.symbol ?? shortV1(entry.tokenAddress)} — controls and market`,
        body: reading.failure ?? 'Each date describes its own reading.',
        attention: false,
        clocks: reading.clocks,
        actions: [{ label: 'Open B20 controls', onClick: actions.onOpenB20 }],
      });
    }
  }

  const tiles: TodayTileV1[] = check
    ? [
        { label: check.official.length === 1 ? 'stock held' : 'stocks held', value: String(check.official.length), attention: false },
        { label: check.lookalikes.length === 1 ? 'address to check' : 'addresses to check', value: String(check.lookalikes.length), attention: check.lookalikes.length > 0 },
        { label: "tokens outside Miorail's reviewed coverage", value: String(check.unchecked.length), attention: false },
        { label: 'markets under watch', value: radar ? String(radar.watches.length) : '—', attention: false },
      ]
    : [];

  const suggestions: TodayActionV1[] = [];
  const lookalike = check?.lookalikes[0];
  if (lookalike) {
    suggestions.push({ label: `Is ${lookalike.symbol} real?`, onClick: () => actions.onInvestigate(lookalike.address) });
  }
  suggestions.push({ label: TODAY_REWARDS_QUESTION_V1, onClick: () => actions.onAskWallet(TODAY_REWARDS_QUESTION_V1) });
  const official = check?.official[0];
  const officialStock = official ? stockNamedV1(official.ticker, input.stocks) : null;
  if (officialStock) {
    suggestions.push({ label: `Open ${officialStock.symbol}`, onClick: () => actions.onOpenStock(officialStock.symbol) });
  }

  return {
    wallet: {
      tiles,
      items,
      loading: input.wallet.loading,
      overviewUpdatedAt: input.wallet.overviewUpdatedAt ?? null,
      dataFreshness: input.wallet.dataFreshness ?? null,
      balances: input.wallet.rows !== undefined ? {
        rows: input.wallet.rows ?? [],
        loading: input.wallet.loading,
        unavailableReason: input.wallet.failed ? 'Your balances could not be refreshed. Try again later.' : null,
      } : null,
      onInvestigate: actions.onInvestigate,
      unavailable: input.wallet.failed
        ? 'Your balances could not be read. This is not a statement about what you hold.'
        : null,
    },
    stockActions: { onOpenStock: actions.onOpenStock, onOpenDividends: actions.onOpenDividends ?? null },
    ask: {
      ...ask,
      placeholder: 'Paste a token address, name a stock, or ask what you can claim',
      suggestions,
    },
    onSignIn: null,
  };
}

// ---------------------------------------------------------------------------
// The holdings, by name and face.
//
// "Official stocks 2" told the operator a count and nothing else (2026-10-19:
// «даже нет лого акций … не понятно … какие именно у него в кошельке бумаги
// лежат»), and the first screen showed one holding of the two. Every holding
// now leads with Coinbase's own icon, its ticker and its company, the largest
// first. The value is the issuer's reference value, as before: it is said as
// one, beside its own date, and never as what a sale would return. The price
// on Base is a different number on a different clock and is labelled so.
// ---------------------------------------------------------------------------

/** The fields of a My stocks holding this view reads, structurally. */
export interface TodayHoldingSourceV1 {
  tokenAddress: string;
  tokenSymbol: string;
  symbol: string;
  company: string;
  tokens: string;
  reference: { valueUsd: string; publishedAt: string } | null;
}

/** What the Stocks board knows about a token: its icon and its price on Base. */
export interface TodayHoldingQuoteV1 {
  iconPath: string | null;
  price: string | null;
  change: string | null;
}

export interface TodayHoldingTileV1 {
  tokenAddress: string;
  tokenSymbol: string;
  symbol: string;
  company: string;
  iconPath: string | null;
  tokens: string;
  value: number | null;
  /** `≈ $0.19`, or what stands in for a value nobody published. */
  valueLabel: string;
  referenceAt: string | null;
  /** `$214.30 on Base · +0.42% 24h`, or null when the board priced nothing. */
  baseLine: string | null;
}

export interface TodayHoldingsViewV1 {
  tiles: TodayHoldingTileV1[];
  /** Null when no holding has a reference value to add up. */
  total: { label: string; priced: number; unpriced: number } | null;
}

function approxUsdV1(value: number): string {
  return value > 0 && value < 0.01
    ? '≈ less than $0.01'
    : `≈ $${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function todayHoldingsViewV1(
  holdings: readonly TodayHoldingSourceV1[],
  quotes: ReadonlyMap<string, TodayHoldingQuoteV1> | null | undefined,
): TodayHoldingsViewV1 {
  const tiles = holdings.map((holding): TodayHoldingTileV1 => {
    const quote = quotes?.get(holding.tokenAddress.toLowerCase()) ?? null;
    const value = holding.reference ? Number(holding.reference.valueUsd) : NaN;
    const known = Number.isFinite(value) && value >= 0;
    return {
      tokenAddress: holding.tokenAddress,
      tokenSymbol: holding.tokenSymbol,
      symbol: holding.symbol,
      company: holding.company,
      iconPath: quote?.iconPath ?? null,
      tokens: holding.tokens,
      value: known ? value : null,
      valueLabel: known ? approxUsdV1(value) : 'Reference value unavailable',
      referenceAt: known ? holding.reference!.publishedAt : null,
      baseLine: quote?.price ? `${quote.price} on Base${quote.change ? ` · ${quote.change} 24h` : ''}` : null,
    };
  });
  tiles.sort((left, right) =>
    (right.value ?? -1) - (left.value ?? -1) || left.tokenSymbol.localeCompare(right.tokenSymbol));
  const priced = tiles.filter((tile) => tile.value !== null);
  const sum = priced.reduce((total, tile) => total + tile.value!, 0);
  return {
    tiles,
    total: priced.length > 0 ? { label: approxUsdV1(sum), priced: priced.length, unpriced: tiles.length - priced.length } : null,
  };
}
