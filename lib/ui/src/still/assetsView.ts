import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { formatCents, formatTokenAmount } from '@mioagent/still-engine/format';
import { CRYPTO } from '@mioagent/still-engine/registry';
import { dividendMoneyV1, positiveDividendMoneyV1, sumDividendMoneyV1 } from './dividendMoney';


// ---------------------------------------------------------------------------
// Assets: the wallet's reviewed holdings, modelled capacity and recorded loans.
//
// From the Mirror report (the chain at one block) and Miorail's dividend
// calendar for this wallet. A dividend reaches whoever holds the token when it
// converts, as more shares; an amount ahead is an estimate and says so.
// ---------------------------------------------------------------------------

export interface AssetRowV1 {
  id: string;
  kind: 'stock' | 'crypto';
  name: string;
  /** "4.2 NVDAc". */
  amount: string;
  /** "$785.57", or null when the price was not read. */
  value: string | null;
  lines: Array<{ text: string; strong?: string }>;
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
  total: string | null;
  count: number;
  rows: AssetRowV1[];
  loans: LoanRowV1[];
  /** Missing venue debt reads cannot establish a count of zero loans. */
  loansReadComplete: boolean;
  receivedDividends: string | null;
}

/** "4.2" from raw units: the engine's amount, truncated to four places, trailing zeros gone. */
export function tokenTextV1(raw: bigint, decimals: number): string {
  return formatTokenAmount(raw, decimals).replace(/\.?0+$/, '');
}

function venueNameV1(venue: string): string {
  return venue === 'aave-v4' ? 'Aave' : 'Morpho';
}

export function assetsViewV1(input: { report: MirrorReport; dividends?: DividendWalletResponseV1 | null }): AssetsViewV1 {
  const { report } = input;
  const debtOn = new Map(report.venues.map((v) => [v.venue === 'aave-v4' ? 'aave-v4' : v.market.toLowerCase(), v]));
  const rows: AssetRowV1[] = [];
  let total = BigInt(0);
  let priced = true;
  for (const line of report.assets) {
    const wallet = line.wallet ? BigInt(line.wallet.raw) : BigInt(0);
    const pledged = line.pledged ? BigInt(line.pledged.raw) : BigInt(0);
    const decimals = line.wallet?.decimals ?? line.pledged?.decimals ?? 8;
    if (wallet + pledged === BigInt(0)) continue;
    if (line.valueCents === null) priced = false;
    else total += BigInt(line.valueCents);
    const lines: AssetRowV1['lines'] = [];
    const venue = line.venue === 'aave-v4' ? debtOn.get('aave-v4') : report.venues.find((v) => v.venue === 'morpho' && v.label.includes(line.symbol === 'ETH' ? 'WETH' : line.symbol));
    const owes = venue?.debtCents !== null && venue?.debtCents !== undefined && venue.debtCents !== '0';
    if (pledged > BigInt(0)) {
      lines.push({
        strong: `${tokenTextV1(pledged, decimals)} ${owes ? `hold up your ${venueNameV1(line.venue)} loan` : `pledged on ${venueNameV1(line.venue)}`}`,
        text: wallet > BigInt(0) ? ` · ${tokenTextV1(wallet, decimals)} free` : '',
      });
    } else if (line.capacityCents !== null && line.capacityCents !== '0') {
      lines.push({ text: `Modelled room · up to ${formatCents(line.capacityCents)} on ${venueNameV1(line.venue)}` });
    } else if (line.limits.length > 0) {
      lines.push({ text: 'Not counted now: the venue limits it' });
    }
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
    rows.push({
      id: line.asset,
      kind: line.kind,
      name: line.name,
      amount: `${tokenTextV1(wallet + pledged, decimals)} ${line.symbol === 'ETH' ? 'ETH' : line.symbol}`,
      value: line.valueCents === null ? null : formatCents(line.valueCents),
      lines,
    });
  }
  rows.sort((a, b) => valueOfV1(b) - valueOfV1(a));

  const loans: LoanRowV1[] = report.venues
    .filter((v) => v.debtCents !== null && v.debtCents !== '0')
    .map((v) => ({
      id: v.market,
      // Aave's USDC debt belongs to the whole Spoke, not to a guessed stock.
      repayHref: v.venue === 'aave-v4' ? '/repay' :
        CRYPTO.find(asset => asset.morphoMarket.toLowerCase() === v.market.toLowerCase()) ? `/repay?asset=${CRYPTO.find(asset => asset.morphoMarket.toLowerCase() === v.market.toLowerCase())!.id === 'ETH' ? 'WETH' : 'cbBTC'}` : null,
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
    count: rows.length,
    rows,
    loans,
    loansReadComplete: report.venues.length > 0 && report.venues.every(venue => venue.debtCents !== null),
    receivedDividends: positiveDividendMoneyV1(input.dividends?.receivedUsd),
  };
}

function valueOfV1(row: AssetRowV1): number {
  return row.value === null ? -1 : Number(row.value.replace(/[$,]/g, ''));
}
