import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { formatCents } from '@mioagent/still-engine/format';
import { tokenTextV1 } from './assetsView';

// ---------------------------------------------------------------------------
// Home's wallet card (operator, 2026-11-03: «сейчас не понятно что лежит у
// меня в кошельке»): what the wallet holds now, the coins a loan moves and
// the stocks, with what is pledged said apart from what is free.
//
// Three reads, each for what it is: the Still report (the reviewed stocks,
// cbBTC and ETH with WETH, at one block, priced by the venues' own oracles),
// the wallet's USDC, and the dividend calendar's read of every Coinbase stock
// the wallet holds. A read that did not answer is said so, never a zero.
// ---------------------------------------------------------------------------

export interface WalletRowV1 {
  id: string;
  symbol: string;
  kind: 'cash' | 'crypto' | 'stock';
  /** All of it, wallet and pledged: "0.0301". */
  amount: string;
  /** What all of it is worth, or null when it is not priced. */
  value: string | null;
  /** Where it is when not all in the wallet, or why it is not read. */
  where: string | null;
}

export interface WalletViewV1 {
  block: string;
  rows: WalletRowV1[];
  /** Coinbase stocks outside Still's reviewed set: an amount, priced on their own page. */
  others: Array<{ symbol: string; amount: string; href: string }>;
}

/** The wallet's USDC as the page holds it: read, still being read, or not read. */
export type WalletUsdcV1 = { raw: string; decimals: number } | 'loading' | 'unread';

const UNREAD_V1 = 'not read just now: our failure, not a fact about the wallet';

function venueNameV1(venue: string): string {
  return venue === 'aave-v4' ? 'Aave' : 'Morpho';
}

/** "1.23456789" as base units with its own places, so it is shown like every other amount. */
function decimalTextV1(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return tokenTextV1(BigInt(`${whole}${fraction}`), fraction.length);
}

export function walletViewV1(input: { report: MirrorReport; usdc: WalletUsdcV1; dividends?: DividendWalletResponseV1 | null }): WalletViewV1 {
  const { report } = input;
  const rows: WalletRowV1[] = [];

  if (input.usdc === 'loading' || input.usdc === 'unread') {
    rows.push({ id: 'USDC', symbol: 'USDC', kind: 'cash', amount: input.usdc === 'loading' ? '…' : '—', value: null, where: input.usdc === 'unread' ? UNREAD_V1 : null });
  } else {
    const raw = BigInt(input.usdc.raw);
    // USDC counts at $1: cents are its base units over 10^(decimals − 2).
    const cents = input.usdc.decimals >= 2 ? raw / 10n ** BigInt(input.usdc.decimals - 2) : raw * 10n ** BigInt(2 - input.usdc.decimals);
    rows.push({ id: 'USDC', symbol: 'USDC', kind: 'cash', amount: tokenTextV1(raw, input.usdc.decimals), value: formatCents(cents.toString()), where: null });
  }

  // The report has a line only for what is held or not read: a measured zero
  // has none. ETH is shown either way, as what a wallet without sponsored gas
  // pays with; cbBTC and the stocks when there is some.
  const coins = new Map<string, WalletRowV1>();
  const stocks: Array<WalletRowV1 & { cents: bigint }> = [];
  for (const line of report.assets) {
    const decimals = line.wallet?.decimals ?? line.pledged?.decimals ?? 8;
    const unread = line.wallet === null;
    const wallet = line.wallet ? BigInt(line.wallet.raw) : 0n;
    const pledged = line.pledged ? BigInt(line.pledged.raw) : 0n;
    const total = wallet + pledged;
    if (!unread && total === 0n) continue;
    const venue = line.venue === 'aave-v4' ? report.venues.find((v) => v.venue === 'aave-v4') : report.venues.find((v) => v.venue === 'morpho' && v.label.includes(line.symbol === 'ETH' ? 'WETH' : line.symbol));
    const owes = venue?.debtCents != null && venue.debtCents !== '0';
    const under = owes ? ', under your loan' : '';
    const row: WalletRowV1 = {
      id: line.asset,
      symbol: line.symbol,
      kind: line.kind,
      amount: unread ? '—' : tokenTextV1(total, decimals),
      value: unread || line.valueCents === null ? null : formatCents(line.valueCents),
      where: unread
        ? UNREAD_V1
        : pledged === 0n
          ? null
          : pledged === total
            ? `all pledged on ${venueNameV1(line.venue)}${under}`
            : `${tokenTextV1(pledged, decimals)} of it pledged on ${venueNameV1(line.venue)}${under}`,
    };
    if (line.kind === 'crypto') coins.set(line.asset, row);
    else stocks.push({ ...row, cents: line.valueCents === null ? -1n : BigInt(line.valueCents) });
  }
  rows.push(coins.get('ETH') ?? { id: 'ETH', symbol: 'ETH', kind: 'crypto', amount: '0', value: formatCents('0'), where: null });
  const btc = coins.get('cbBTC');
  if (btc) rows.push(btc);
  stocks.sort((a, b) => (a.cents === b.cents ? a.symbol.localeCompare(b.symbol) : a.cents > b.cents ? -1 : 1));
  rows.push(...stocks.map(({ cents: _cents, ...row }) => row));

  const reviewed = new Set(report.assets.map((line) => line.token.toLowerCase()));
  const others = (input.dividends?.holdings ?? [])
    .filter((holding) => !reviewed.has(holding.tokenAddress.toLowerCase()) && /[1-9]/.test(holding.tokens))
    .map((holding) => ({ symbol: holding.tokenSymbol, amount: decimalTextV1(holding.tokens), href: `/stocks/${holding.symbol.toLowerCase()}` }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  return { block: Number(report.reading.block).toLocaleString('en-US'), rows, others };
}
