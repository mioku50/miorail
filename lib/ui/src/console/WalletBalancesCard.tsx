import React from 'react';

void React;

// ---------------------------------------------------------------------------
// What the wallet actually holds.
//
// The Portfolio surface was built to answer one question — what have my B20
// tokens' controls done since I bought them — and it answered only that. Every
// ordinary balance was filtered out twice on the way to the screen: native ETH
// by an address regex it cannot match (`native` is not forty hex characters),
// and every ERC-20 by a join against the B20 sweep. A wallet holding ETH and
// USDC saw an empty page.
//
// So this card is deliberately NOT about B20. It states balances, and it
// distinguishes the three things a balance list can mean:
//
//   * a number that was read
//   * a provider that did not answer — never rendered as zero, because "we
//     could not look" and "you have nothing" are different facts and only one
//     of them is about the wallet
//   * a wallet that genuinely holds nothing
//
// USD values are shown only where the provider supplied one. A balance with no
// price is a balance, not a zero-dollar holding.
// ---------------------------------------------------------------------------

export interface WalletBalanceEntryV1 {
  symbol: string;
  name?: string | null;
  /** `native` for ETH; a 0x address for everything else. */
  address: string;
  /** Already formatted by the server, in the token's own decimals. */
  balanceFormatted?: string | null;
  usdValue?: string | number | null;
  /** The provider's spam heuristic. Kept out of the total and shown apart. */
  possibleSpam?: boolean;
  verified?: boolean;
  /** Miorail's official registry, joined by address on the server. */
  registry?: WalletRegistryMarkV1 | null;
}

export interface WalletRegistryMarkV1 {
  standing: 'official' | 'lookalike';
  ticker: string;
  officialAddress?: string;
}

export interface WalletRegistryMarkViewV1 {
  label: string;
  /** `.tag` for official, `.tag.a` for a lookalike. Official is an identity,
   * not a verdict, so it wears no quality colour. */
  tone: 'n' | 'a';
  title: string;
}

/**
 * The registry's word on one balance row.
 *
 * A provider names a token by the symbol its contract chose. A wallet held 15
 * "AAPLc" at 0x2a97…8636 and both balance lists showed it beside the real
 * NVDAc as one more holding. A lookalike is two strings that matched and two
 * addresses that did not, and the mark says only that.
 */
export function walletRegistryMarkViewV1(registry: WalletRegistryMarkV1 | null | undefined): WalletRegistryMarkViewV1 | null {
  if (!registry) return null;
  if (registry.standing === 'official') {
    return { label: `official ${registry.ticker}`, tone: 'n', title: `Listed by its issuer as ${registry.ticker}, at this exact address.` };
  }
  const official = registry.officialAddress
    ? ` The official ${registry.ticker} is ${registry.officialAddress.slice(0, 6)}…${registry.officialAddress.slice(-4)}.`
    : '';
  return {
    label: `not the official ${registry.ticker}`,
    tone: 'a',
    title: `This contract uses ${registry.ticker}'s ticker at another address.${official}`,
  };
}

/** One row of Routes AI's "Your wallet". */
export interface PlanWalletRowV1 {
  asset: string;
  amount: string;
  usd: string;
  mark: WalletRegistryMarkViewV1 | null;
}

/**
 * Routes AI's "Your wallet", from the same balances the card reads.
 *
 * Both surfaces mapped the provider's rows by hand and read `balanceUsd`, a
 * field the portfolio answer does not carry, so every dollar cell was a dash,
 * USDC's too. They also listed zero and spam rows in the provider's order.
 * This list is where a goal starts, so what has a price leads.
 */
export function planWalletRowsV1(rows: readonly WalletBalanceEntryV1[]): PlanWalletRowV1[] {
  const { shown } = walletBalanceRowsV1(rows);
  const value = (row: WalletBalanceEntryV1) => {
    const amount = Number(row.usdValue ?? NaN);
    return Number.isFinite(amount) ? amount : -1;
  };
  const ordered = [...shown].sort((left, right) => {
    if (isNativeBalanceV1(left.address) !== isNativeBalanceV1(right.address)) return isNativeBalanceV1(left.address) ? -1 : 1;
    return value(right) - value(left);
  });
  return ordered.map((row) => ({
    asset: row.symbol,
    amount: row.balanceFormatted ?? '—',
    usd: balanceUsdLabelV1(row.usdValue) ?? '—',
    mark: walletRegistryMarkViewV1(row.registry),
  }));
}

export interface WalletBalancesModelV1 {
  loading: boolean;
  /** Set when the list could not be read. Renders INSTEAD of any number. */
  unavailableReason: string | null;
  rows: readonly WalletBalanceEntryV1[];
  /** Named so the card can say the ordinary balances are complete but the B20
   * ones were not looked at, or vice versa. */
  note?: string | null;
}

/** True for the native asset, whatever casing the server used. */
export function isNativeBalanceV1(address: string): boolean {
  return address.toLowerCase() === 'native';
}

/**
 * Rows worth showing, native first.
 *
 * Zero balances are dropped — a wallet that once held a token still gets a row
 * from most providers, and a page of zeroes buries the two lines that matter.
 * Spam-flagged tokens are dropped too: they are unsolicited transfers, and
 * listing them as holdings dignifies them as such.
 */
export function walletBalanceRowsV1(
  rows: readonly WalletBalanceEntryV1[],
): { shown: WalletBalanceEntryV1[]; hiddenZero: number; hiddenSpam: number } {
  let hiddenZero = 0;
  let hiddenSpam = 0;
  const shown: WalletBalanceEntryV1[] = [];
  for (const row of rows) {
    if (row.possibleSpam === true) {
      hiddenSpam += 1;
      continue;
    }
    const amount = Number(row.balanceFormatted ?? '0');
    // Not `> 0`: a formatted string the server could not parse arrives as NaN,
    // and dropping it silently would hide a token the wallet does hold.
    if (Number.isFinite(amount) && amount === 0) {
      hiddenZero += 1;
      continue;
    }
    shown.push(row);
  }
  shown.sort((left, right) => {
    if (isNativeBalanceV1(left.address) !== isNativeBalanceV1(right.address)) {
      return isNativeBalanceV1(left.address) ? -1 : 1;
    }
    return left.symbol.localeCompare(right.symbol);
  });
  return { shown, hiddenZero, hiddenSpam };
}

/** `$1,234.56`, or null when the provider priced nothing. */
export function balanceUsdLabelV1(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return null;
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function WalletBalancesCard(model: WalletBalancesModelV1) {
  const { shown, hiddenZero, hiddenSpam } = walletBalanceRowsV1(model.rows);

  return (
    <div className="rp">
      <div className="rph">
        <b>Wallet balances</b>
        <span className="rt">Base mainnet</span>
      </div>
      <div className="rpb">
        {model.loading ? (
          <p className="empty">Reading balances…</p>
        ) : model.unavailableReason ? (
          // No list, and no zeroes standing in for one.
          <p className="empty">{model.unavailableReason}</p>
        ) : shown.length === 0 ? (
          <p className="empty">This wallet holds no ETH or tokens on Base.</p>
        ) : (
          <>
            {shown.map((row) => {
              const usd = balanceUsdLabelV1(row.usdValue);
              return (
                <div className="qrow" key={row.address}>
                  <span>
                    {row.symbol}
                    {isNativeBalanceV1(row.address) && <span className="tag">native</span>}
                    {(() => {
                      const mark = walletRegistryMarkViewV1(row.registry);
                      return mark ? (
                        <span className={`tag${mark.tone === 'a' ? ' a' : ''}`} title={mark.title}>
                          {mark.label}
                        </span>
                      ) : null;
                    })()}
                  </span>
                  {/* Two numbers on one line read as one broken value:
                      `0.5925 $0.59` has to be parsed before it can be read.
                      The holding is the fact; the dollar figure is a
                      conversion of it, so it goes underneath and carries `≈`
                      to say it is derived rather than held. */}
                  <span className="v mono">
                    {row.balanceFormatted ?? '—'}
                    {usd && <span className="usd">≈ {usd}</span>}
                  </span>
                </div>
              );
            })}
            {(hiddenZero > 0 || hiddenSpam > 0) && (
              <p className="lnote">
                {[
                  hiddenZero > 0 ? `${hiddenZero} zero balance${hiddenZero === 1 ? '' : 's'}` : null,
                  hiddenSpam > 0 ? `${hiddenSpam} flagged as spam` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}{' '}
                hidden.
              </p>
            )}
          </>
        )}
        {model.note && <p className="lnote">{model.note}</p>}
      </div>
    </div>
  );
}
