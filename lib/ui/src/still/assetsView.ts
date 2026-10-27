import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { formatCents, formatTokenAmount } from '@mioagent/still-engine/format';


// ---------------------------------------------------------------------------
// Assets: what the wallet holds that Still can lend against, and its loans.
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
}

export interface AssetsViewV1 {
  total: string | null;
  count: number;
  rows: AssetRowV1[];
  loans: LoanRowV1[];
  receivedDividends: string | null;
}

/** "4.2" from raw units: the engine's amount, truncated to four places, trailing zeros gone. */
export function tokenTextV1(raw: bigint, decimals: number): string {
  return formatTokenAmount(raw, decimals).replace(/\.?0+$/, '');
}

function venueNameV1(venue: string): string {
  return venue === 'aave-v4' ? 'Aave' : 'Morpho';
}

/** The dividend source keeps four decimal places; a positive fraction of a cent is not zero. */
function dividendMoneyV1(value: string | number): string {
  const usd = Number(value);
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
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
      lines.push({ text: `Free · could carry up to ${formatCents(line.capacityCents)} on ${venueNameV1(line.venue)}` });
    } else if (line.limits.length > 0) {
      lines.push({ text: 'Not counted now: the venue limits it' });
    }
    const dividend = input.dividends?.holdings.find((h) => h.tokenAddress === line.token.toLowerCase());
    if (dividend) {
      const received = dividend.received.reduce((sum, event) => sum + Number(event.usd ?? 0), 0);
      if (received > 0) lines.push({ text: `Dividends reinvested so far: ${dividendMoneyV1(received)}` });
      const next = dividend.upcoming[0];
      if (next && next.usd !== null) {
        const estimate = next.kind === 'estimate';
        const amount = dividendMoneyV1(next.usd);
        lines.push({ text: `Dividend ahead: ${estimate && !amount.startsWith('<') ? '≈ ' : ''}${amount}, if you hold ${dividend.tokenSymbol} when it converts${estimate ? ' (an estimate)' : ''}` });
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
      label: v.label,
      owed: formatCents(v.debtCents!),
      rate: v.borrowRateBps === null ? null : `${(v.borrowRateBps / 100).toFixed(2)}% a year, variable`,
      safety: v.safety ? `Prices can fall ${Math.floor(v.safety.marginBps / 100)}% together before liquidation.` : null,
      state: v.safety?.state ?? null,
      liquidation: v.liquidationPrices.map((p) => {
        const name = report.assets.find((l) => l.asset === p.asset)?.name ?? p.asset;
        return p.unreachable ? `${name}: no price of it alone liquidates this loan` : `${name} below ${formatCents(p.priceCents!)}, if only it moved`;
      }),
      more: v.availableCents === null ? null : `Still could lend ${formatCents(v.availableCents)} more here.`,
    }));

  return {
    total: priced ? formatCents(total) : null,
    count: rows.length,
    rows,
    loans,
    receivedDividends: input.dividends && Number(input.dividends.receivedUsd) > 0 ? dividendMoneyV1(input.dividends.receivedUsd) : null,
  };
}

function valueOfV1(row: AssetRowV1): number {
  return row.value === null ? -1 : Number(row.value.replace(/[$,]/g, ''));
}
