import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { formatCents, formatTokenAmount } from '@mioagent/still-engine/format';
import { TERMS } from '@mioagent/still-engine/policy';
import { CRYPTO, STOCKS } from '@mioagent/still-engine/registry';
import { dividendMoneyV1, positiveDividendMoneyV1, sumDividendMoneyV1 } from './dividendMoney';
import { swapTokenGoalV1 } from '../console/goalHandoff';
import { tokenDecimalV1 } from '../console/stockSellAmount';


// ---------------------------------------------------------------------------
// Assets: what the wallet holds, its modelled capacity and recorded loans.
//
// From the Mirror report (the chain at one block), the wallet's USDC read
// beside it, and Miorail's dividend calendar for this wallet. A dividend
// reaches whoever holds the token when it converts, as more shares; an amount
// ahead is an estimate and says so. A read that did not answer is said so,
// never a zero (operator, 2026-11-03: «сейчас не понятно что лежит у меня в
// кошельке»).
// ---------------------------------------------------------------------------

export interface AssetRowV1 {
  id: string;
  kind: 'stock' | 'crypto' | 'cash';
  name: string;
  /** "4.2 NVDAc". */
  amount: string;
  /** "$785.57", "…" while it is read, or null when it was not read. */
  value: string | null;
  lines: Array<{ text: string; strong?: string }>;
  /** Selling what is free in the wallet on Swap: the goal it hands over, where, and what the link
   * says. For USDC it buys ETH. Absent for nothing free (what is pledged holds up a loan) and for a
   * row not read. */
  sell?: { goal: string; href: string; label: string };
}

export interface LoanRowV1 {
  id: string;
  label: string;
  owed: string;
  rate: string | null;
  /** "Prices can fall 52% together before liquidation." */
  safety: string | null;
  state: 'calm' | 'watch' | 'act' | 'liquidation' | null;
  liquidation: string[];
  more: string | null;
  repayHref?: string | null;
}

export interface AssetsViewV1 {
  /** What the reviewed holdings are worth, wallet and pledged. USDC is not one of them. */
  total: string | null;
  count: number;
  /** USDC when it was read beside the report, ETH, cbBTC and PAXG, then the stocks by value. */
  rows: AssetRowV1[];
  /** Coinbase stocks outside Still's reviewed set: an amount, priced on their own page. */
  others: Array<{ symbol: string; amount: string; href: string }>;
  /** The report's block: "53,000,000". */
  block: string;
  /** The block USDC was read at, when it is another one: it is read on its own (re-audit R7, 2026-11-04). */
  usdcBlock: string | null;
  loans: LoanRowV1[];
  /** Missing venue debt reads cannot establish a count of zero loans. */
  loansReadComplete: boolean;
  receivedDividends: string | null;
}

/** The wallet's USDC as the page holds it: read (at its own block, when known), still being read, or not read. */
export type WalletUsdcV1 =
  | {
      raw: string;
      decimals: number;
      block?: string;
      /** Native ETH in wei at the same block, read beside USDC; null when it did not answer. */
      nativeEthRaw?: string | null;
    }
  | 'loading'
  | 'unread';

const SELL_LABEL_V1 = 'Sell for USDC on Swap →';

const UNREAD_V1 = 'Not read just now: our failure, not a fact about the wallet';

/** "4.2" from raw units: the engine's amount, truncated to four places, trailing zeros gone. */
export function tokenTextV1(raw: bigint, decimals: number): string {
  return formatTokenAmount(raw, decimals).replace(/\.?0+$/, '');
}

function venueNameV1(venue: string): string {
  return venue === 'aave-v4' ? 'Aave' : 'Morpho';
}

/** "1.23456789" as base units with its own places, so it is shown like every other amount. */
function decimalTextV1(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return tokenTextV1(BigInt(`${whole}${fraction}`), fraction.length);
}

/** USDC counts at $1: what a loan pays out and a repayment takes. */
/**
 * ETH when the report has no line for it. The report counts ETH only above the network-fee reserve,
 * so a wallet with just its gas money has none there; its ETH is the read beside USDC (2026-11-09:
 * Assets said 0 ETH for a wallet holding 0.0001 ETH). It is not priced: the report's price comes
 * with its line.
 */
function gasEthRowV1(usdc: WalletUsdcV1 | undefined): AssetRowV1 {
  const row = { id: 'ETH', kind: 'crypto' as const, name: CRYPTO.find((asset) => asset.id === 'ETH')!.name };
  const zero: AssetRowV1 = { ...row, amount: '0 ETH', value: formatCents(BigInt(0)), lines: [] };
  const unread: AssetRowV1 = { ...row, amount: '— ETH', value: null, lines: [{ text: UNREAD_V1 }] };
  if (usdc === 'loading') return { ...row, amount: '… ETH', value: '…', lines: [] };
  if (usdc === 'unread') return unread;
  // Nothing read beside the report: the page says what it said before that read existed.
  const raw = usdc?.nativeEthRaw;
  if (raw === undefined) return zero;
  if (raw === null) return unread;
  const wei = BigInt(raw);
  if (wei === BigInt(0)) return zero;
  return {
    ...row,
    amount: `${tokenTextV1(wei, 18)} ETH`,
    value: '—',
    lines: [{ text: `Network-fee money: Still keeps ${tokenTextV1(TERMS.ethGasReserveWei, 18)} ETH for fees and does not count it` }],
  };
}

function usdcRowV1(usdc: WalletUsdcV1): AssetRowV1 {
  const row = { id: 'USDC', kind: 'cash' as const, name: 'USD Coin' };
  if (usdc === 'loading') return { ...row, amount: '… USDC', value: '…', lines: [] };
  if (usdc === 'unread') return { ...row, amount: '— USDC', value: null, lines: [{ text: UNREAD_V1 }] };
  const raw = BigInt(usdc.raw);
  // Cents are its base units over 10^(decimals − 2).
  const cents = usdc.decimals >= 2 ? raw / BigInt(10) ** BigInt(usdc.decimals - 2) : raw * BigInt(10) ** BigInt(2 - usdc.decimals);
  // Its whole balance, exactly, as Swap's goal: USDC buys ETH there, and the goal can be changed
  // before anything is compared (operator, 2026-11-09: sell from Assets as with the other rows).
  const goal = `Swap ${tokenDecimalV1(raw.toString(), usdc.decimals)} USDC to ETH`;
  return {
    ...row,
    amount: `${tokenTextV1(raw, usdc.decimals)} USDC`,
    value: formatCents(cents),
    lines: [{ text: 'What a loan pays out and Repay takes; not counted in Reviewed holdings' }],
    ...(raw > BigInt(0) ? { sell: { goal, href: `/routes?goal=${encodeURIComponent(goal)}`, label: 'Swap for ETH on Swap →' } } : {}),
  };
}

export function assetsViewV1(input: { report: MirrorReport; dividends?: DividendWalletResponseV1 | null; usdc?: WalletUsdcV1 }): AssetsViewV1 {
  const { report } = input;
  const debtOn = new Map(report.venues.map((v) => [v.venue === 'aave-v4' ? 'aave-v4' : v.market.toLowerCase(), v]));
  const coins = new Map<string, AssetRowV1>();
  const stocks: Array<{ row: AssetRowV1; cents: bigint }> = [];
  let total = BigInt(0);
  let priced = true;
  let count = 0;
  for (const line of report.assets) {
    // The report has a line only for what is held or not read: a measured zero has none.
    const unread = line.wallet === null;
    const wallet = line.wallet ? BigInt(line.wallet.raw) : BigInt(0);
    const pledged = line.pledged ? BigInt(line.pledged.raw) : BigInt(0);
    const decimals = line.wallet?.decimals ?? line.pledged?.decimals ?? 8;
    if (!unread && wallet + pledged === BigInt(0)) continue;
    if (!unread) count += 1;
    if (unread || line.valueCents === null) priced = false;
    else total += BigInt(line.valueCents);
    const lines: AssetRowV1['lines'] = [];
    const venue = line.venue === 'aave-v4' ? debtOn.get('aave-v4') : report.venues.find((v) => v.venue === 'morpho' && v.label.includes(line.symbol === 'ETH' ? 'WETH' : line.symbol));
    const owes = venue?.debtCents !== null && venue?.debtCents !== undefined && venue.debtCents !== '0';
    if (pledged > BigInt(0)) {
      lines.push({
        strong: `${tokenTextV1(pledged, decimals)} ${owes ? `hold up your ${venueNameV1(line.venue)} loan` : `pledged on ${venueNameV1(line.venue)}`}`,
        text: !unread && wallet > BigInt(0) ? ` · ${tokenTextV1(wallet, decimals)} free` : '',
      });
    } else if (!unread && line.capacityCents !== null && line.capacityCents !== '0') {
      lines.push({ text: `Modelled room · up to ${formatCents(line.capacityCents)} on ${venueNameV1(line.venue)}` });
    } else if (!unread && line.limits.length > 0) {
      lines.push({ text: 'Not counted now: the venue limits it' });
    }
    if (unread) lines.push({ text: UNREAD_V1 });
    const dividend = input.dividends?.holdings.find((h) => h.tokenAddress === line.token.toLowerCase());
    if (dividend) {
      const received = sumDividendMoneyV1(dividend.received.map(event => event.usd));
      if (received && received !== '$0.00') lines.push({ text: `Dividends reinvested so far: ${received}` });
      const next = dividend.upcoming[0];
      if (next && next.usd !== null) {
        const estimate = next.kind === 'estimate';
        const amount = dividendMoneyV1(next.usd);
        if (amount) lines.push({ text: `Dividend ahead: ${estimate && !amount.startsWith('<') ? '≈ ' : ''}${amount}, if you hold ${dividend.tokenSymbol} when it converts${estimate ? ' (an estimate)' : ''}` });
      }
    }
    const row: AssetRowV1 = {
      id: line.asset,
      kind: line.kind,
      name: line.name,
      amount: `${unread ? '—' : tokenTextV1(wallet + pledged, decimals)} ${line.symbol}`,
      value: unread || line.valueCents === null ? null : formatCents(line.valueCents),
      lines,
    };
    // The whole free balance, exactly, by its contract. ETH goes without an amount: all of it would
    // leave nothing for the network fee, and the line counts WETH beside it, so Swap asks how much.
    if (!unread && wallet > BigInt(0)) {
      const goal = line.asset === 'ETH' ? swapTokenGoalV1('ETH') : swapTokenGoalV1(line.token, tokenDecimalV1(wallet.toString(), decimals));
      row.sell = { goal, href: `/routes?goal=${encodeURIComponent(goal)}`, label: SELL_LABEL_V1 };
    }
    if (line.kind === 'crypto') coins.set(line.asset, row);
    else stocks.push({ row, cents: row.value === null ? BigInt(-1) : BigInt(line.valueCents!) });
  }

  const rows: AssetRowV1[] = input.usdc === undefined ? [] : [usdcRowV1(input.usdc)];
  // ETH is shown either way, as what a wallet without sponsored gas pays
  // with; cbBTC, gold and the stocks when there is some.
  rows.push(coins.get('ETH') ?? gasEthRowV1(input.usdc));
  const btc = coins.get('cbBTC');
  if (btc) rows.push(btc);
  const gold = coins.get('PAXG');
  if (gold) rows.push(gold);
  stocks.sort((a, b) => (a.cents === b.cents ? a.row.name.localeCompare(b.row.name) : a.cents > b.cents ? -1 : 1));
  rows.push(...stocks.map((stock) => stock.row));

  const reviewed = new Set([...STOCKS.map((stock) => stock.token), ...report.assets.map((line) => line.token)].map((token) => token.toLowerCase()));
  const others = (input.dividends?.holdings ?? [])
    .filter((holding) => !reviewed.has(holding.tokenAddress.toLowerCase()) && /[1-9]/.test(holding.tokens))
    .map((holding) => ({ symbol: holding.tokenSymbol, amount: decimalTextV1(holding.tokens), href: `/stocks/${holding.symbol.toLowerCase()}` }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const loans: LoanRowV1[] = report.venues
    .filter((v) => v.debtCents !== null && v.debtCents !== '0')
    .map((v) => ({
      id: v.market,
      // Aave's USDC debt belongs to the whole Spoke, not to a guessed stock.
      repayHref: v.venue === 'aave-v4' ? '/repay' :
        CRYPTO.find(asset => asset.morphoMarket.toLowerCase() === v.market.toLowerCase()) ? `/repay?asset=${CRYPTO.find(asset => asset.morphoMarket.toLowerCase() === v.market.toLowerCase())!.id === 'ETH' ? 'WETH' : CRYPTO.find(asset => asset.morphoMarket.toLowerCase() === v.market.toLowerCase())!.id}` : null,
      label: v.label,
      owed:
        v.debtAtomic != null && BigInt(v.debtAtomic) > BigInt(0) && BigInt(v.debtAtomic) < BigInt(10_000)
          ? `${ formatTokenAmount(BigInt(v.debtAtomic), 6, 6).replace(/\.?0+$/, '') } USDC`
          : formatCents(v.debtCents!),
      rate: v.borrowRateBps === null ? null : `${(v.borrowRateBps / 100).toFixed(2)}% a year, variable`,
      safety: v.safety ? `Prices can fall ${Math.floor(v.safety.marginBps / 100)}% together before liquidation.` : null,
      state: v.safety?.state ?? null,
      liquidation: v.liquidationPrices.map((p) => {
        const name = report.assets.find((l) => l.asset === p.asset)?.name ?? p.asset;
        return p.unreachable ? `${name}: no price of it alone liquidates this loan` : `${name} below ${formatCents(p.priceCents!)}, if only it moved`;
      }),
      more: v.availableCents === null ? null : `Modelled additional room: ${formatCents(v.availableCents)}. A live loan limit has not been checked.`,
    }));

  return {
    total: priced ? formatCents(total) : null,
    count,
    rows,
    others,
    block: Number(report.reading.block).toLocaleString('en-US'),
    usdcBlock: typeof input.usdc === 'object' && input.usdc.block !== undefined && /^\d+$/.test(input.usdc.block) && input.usdc.block !== String(report.reading.block)
      ? Number(input.usdc.block).toLocaleString('en-US') : null,
    loans,
    loansReadComplete: report.venues.length > 0 && report.venues.every(venue => venue.debtCents !== null),
    receivedDividends: positiveDividendMoneyV1(input.dividends?.receivedUsd),
  };
}
