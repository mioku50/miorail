import { stockInboxGroupKeyV1 } from '@mioagent/route-storage/stock-inbox';
import type { RwaSignalCardV1 } from '@mioagent/rwa-dossier/discover';

/**
 * A dividend that reached a token this wallet held, as the dividend read
 * measured it: the multiplier moved at `at`, and this is what it carried.
 */
export interface StockInboxDividendV1 {
  tokenAddress: string;
  at: string;
  company: string;
  symbol: string;
  tokenSymbol: string;
  amountPerShare: string;
  payDate: string;
  tokens: string;
  usd: string | null;
}

/**
 * The personal inbox, in words: one item per issuer transaction or signal,
 * each with a headline and a summary on every surface.
 *
 * An issuer transaction is one personal update, backed by all its raw signals.
 * Equal values in DIFFERENT transactions or contracts never become one story.
 * The web prints a headline after the token's own label, so a headline never
 * repeats it; the summary names the token, for a reader that sees no label.
 */
export function stockInboxNewsV1(
  cards: readonly RwaSignalCardV1[],
  coinbase: ReadonlySet<string>,
  dividends: readonly StockInboxDividendV1[] = [],
) {
  const groups = new Map<string, RwaSignalCardV1[]>();
  for (const card of cards) {
    const key = stockInboxGroupKeyV1({ ...card, chainId: 8453 });
    const group = groups.get(key);
    if (group) group.push(card);
    else groups.set(key, [card]);
  }
  return [...groups.values()].map((rows) => {
    const primary =
      rows.find((row) => row.kind === 'official_asset_multiplier_changed') ??
      rows.find((row) => row.kind === 'official_asset_multiplier_change_scheduled') ??
      rows.find((row) => row.kind === 'official_asset_multiplier_change_cancelled') ??
      rows[0]!;
    const key = stockInboxGroupKeyV1({ ...primary, chainId: 8453 });
    const issuerTransaction = !key.startsWith('signal:');
    const updates = new Map<string, RwaSignalCardV1>();
    for (const row of rows) {
      if (row.kind === 'official_asset_corporate_action_announced') continue;
      // Compatibility setter logs with identical terms corroborate one change.
      updates.set(
        `${row.kind}:${String(row.facts.multiplierWad)}:${String(row.facts.effectiveAt ?? '')}`,
        row,
      );
    }
    const announcements = [
      ...new Set(
        rows
          .filter((row) => row.kind === 'official_asset_corporate_action_announced')
          .map((row) => row.facts.description)
          .filter((text): text is string => typeof text === 'string' && text.length > 0),
      ),
    ].map((text) => ` Issuer announcement: “${text}”.`);
    let headline: string | null;
    let summary: string | null;
    // The multiplier moved because a dividend converted. The issuer's log
    // says "shares per token changed"; for the holder that IS the dividend.
    const dividend =
      primary.kind === 'official_asset_multiplier_changed'
        ? dividends.find(
            (row) =>
              row.tokenAddress === primary.subjectAddress &&
              Date.parse(row.at) === Date.parse(primary.occurredAt),
          )
        : undefined;
    if (dividend && updates.size === 1) {
      const value = multiplierLabel(primary.facts.multiplierWad);
      headline = `${dividend.company}'s dividend arrived`;
      summary =
        `${dividend.company} paid $${dividend.amountPerShare} a share on ${dayV1(dividend.payDate)}. ` +
        `Coinbase reinvested it as more shares${value ? `: one ${dividend.tokenSymbol} now represents ${value} ${dividend.symbol} shares` : ''}. ` +
        `On the ${dividend.tokens} ${dividend.tokenSymbol} you held, that is ${usdV1(dividend.usd)}.` +
        announcements.join('');
    } else if (updates.size && [...updates.values()].every(isTermsChange)) {
      const parts = [...updates.values()].map((row) => {
        const label = row.subjectTicker ?? row.subjectAddress;
        const value = multiplierLabel(row.facts.multiplierWad);
        if (row.kind === 'official_asset_multiplier_change_scheduled') {
          const terms = coinbase.has(row.subjectAddress) ? 'shares per token' : 'as the multiplier';
          return `The issuer scheduled ${value ? `${value} ${terms}` : 'a multiplier change'} for ${String(row.facts.effectiveAt ?? 'an unread effective date')}. This is a plan, not an applied change.`;
        }
        if (row.kind === 'official_asset_multiplier_change_cancelled')
          return 'The issuer cancelled its scheduled multiplier change.';
        return coinbase.has(row.subjectAddress)
          ? `The issuer set the shares represented by one ${label}${value ? ` to ${value}` : ' to a value that could not be decoded'}.`
          : `${label} recorded a new multiplier${value ? ` of ${value}` : ''}. Its meaning depends on the issuer.`;
      });
      headline =
        updates.size > 1
          ? 'Issuer updated token terms'
          : primary.kind === 'official_asset_multiplier_changed'
            ? coinbase.has(primary.subjectAddress)
              ? 'Shares per token changed'
              : 'Token multiplier changed'
            : primary.kind === 'official_asset_multiplier_change_scheduled'
              ? coinbase.has(primary.subjectAddress)
                ? 'Shares per token change scheduled'
                : 'Multiplier change scheduled'
              : 'Scheduled change cancelled';
      summary = parts.join(' ') + announcements.join('');
    } else {
      // A market measurement, a declaration, a listing, a lookalike or an
      // announcement on its own: every item an assistant reads has words.
      ({ headline, summary } = signalWordsV1(primary));
    }
    return {
      primary,
      evidenceSignalIds: rows.map((row) => row.signalId),
      transactionHash: issuerTransaction
        ? String(primary.facts.transactionHash).toLowerCase()
        : null,
      occurredAt: primary.occurredAt,
      recordedAt: rows[0]!.recordedAt,
      headline,
      summary,
    };
  });
}

function isTermsChange(row: RwaSignalCardV1): boolean {
  return (
    row.kind === 'official_asset_multiplier_changed' ||
    row.kind === 'official_asset_multiplier_change_scheduled' ||
    row.kind === 'official_asset_multiplier_change_cancelled'
  );
}

/** One signal that is not an issuer's terms change, in the holder's words. */
function signalWordsV1(card: RwaSignalCardV1): { headline: string | null; summary: string | null } {
  const facts = card.facts;
  const text = (key: string): string | null => {
    const value = facts[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  // A market signal's own `ticker` fact is a shortened address; the card's
  // ticker is the token's name.
  const token = card.subjectTicker ?? `${card.subjectAddress.slice(0, 8)}…${card.subjectAddress.slice(-4)}`;
  const destination = text('destination') ?? 'USDC';
  const size = cashV1(text('requestedCashAtomic'));
  switch (card.kind) {
    case 'official_asset_market_became_active': {
      const cost = percentV1(text('roundTripCostBps'));
      return {
        headline: `Can be sold for ${destination} again`,
        summary: `Miorail found a route to sell ${token} for ${destination} again; the measurement before found none.${
          size ? ` The largest size that went through was ${size}${cost ? `, for a round trip of ${cost}` : ''}.` : ''
        }`,
      };
    }
    case 'official_asset_market_became_unreachable':
      return {
        headline: 'No route to sell found',
        summary: `Miorail's latest measurement found no route to sell ${token} for ${destination}${
          size ? `, even at ${size}` : ''
        }; the one before found a route. The measurement itself worked.`,
      };
    case 'official_asset_cash_exit_changed': {
      const before = percentV1(text('previousRoundTripCostBps'));
      const after = percentV1(text('roundTripCostBps'));
      return {
        headline: 'Cost to sell changed',
        summary: `A ${size ?? 'measured'} round trip in ${token} now costs ${after ?? 'a new amount'}, against ${
          before ?? 'an earlier reading'
        } at the measurement before.`,
      };
    }
    case 'official_asset_dividend_declared': {
      const company = text('company') ?? 'The company';
      const amount = text('amountPerShare');
      const pay = text('payDate');
      return {
        headline: `${company} declared a dividend`,
        summary: `${company} declared ${amount ? `$${amount} a share` : 'a dividend'}${pay ? `, payable ${dayV1(pay)}` : ''}. ${token} takes it as more shares per token when it converts.`,
      };
    }
    case 'official_asset_lookalike_created': {
      const official = text('officialTicker') ?? card.officialTicker ?? 'an official stock';
      const declared = text('launchSymbol') || text('launchName');
      return {
        headline: 'A lookalike appeared',
        summary: `A new token${declared ? ` calling itself “${declared}”` : ''} resembles ${official}. It is a different contract, not ${official}.`,
      };
    }
    case 'official_source_added_asset':
    case 'official_source_removed_asset': {
      const source = sourceV1(text('sourceKind'));
      return card.kind === 'official_source_added_asset'
        ? { headline: `Listed by ${source}`, summary: `${token} is now listed by ${source}.` }
        : {
            headline: `No longer listed by ${source}`,
            summary: `${token} is no longer listed by ${source}. Only that source changed.`,
          };
    }
    case 'official_asset_corporate_action_announced': {
      const said = text('description');
      return {
        headline: 'Issuer announcement',
        summary: said
          ? `${token}'s issuer announced onchain: “${said}”.`
          : `${token}'s issuer published an announcement onchain; its text could not be read.`,
      };
    }
    case 'official_asset_multiplier_changed': {
      const value = multiplierLabel(facts.multiplierWad);
      return {
        headline: 'Shares per token changed',
        summary: value
          ? `${token} recorded a new multiplier of ${value}.`
          : `${token} recorded a new multiplier that could not be read.`,
      };
    }
    default:
      return { headline: null, summary: null };
  }
}

function sourceV1(kind: string | null): string {
  return kind === 'base_product_list'
    ? 'the Base product page'
    : kind === 'coinbase_stocks_api'
      ? 'the Coinbase Stocks API'
      : kind === 'backed_assets_api'
        ? 'the Backed bTokens API'
        : 'the Base docs';
}

/** "$10,000" from USDC atomic units. */
function cashV1(atomic: string | null): string | null {
  if (atomic === null || !/^[0-9]{1,30}$/.test(atomic)) return null;
  const dollars = Number(BigInt(atomic) / 1_000_000n);
  return `$${dollars.toLocaleString('en-US')}`;
}

/** "0.08%" from basis points. */
function percentV1(bps: string | null): string | null {
  if (bps === null || !/^-?[0-9]{1,9}$/.test(bps)) return null;
  return `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** "Oct 1" from a New York date. */
function dayV1(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

function usdV1(value: string | null): string {
  const n = Number(value);
  if (value === null || !Number.isFinite(n)) return 'an amount Miorail could not value';
  return n < 0.01 ? 'less than $0.01' : `about $${n.toFixed(2)}`;
}

function multiplierLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const wad = BigInt(value),
    scale = 100_000_000n;
  const rounded = (wad + 5_000_000_000n) / 10_000_000_000n;
  const fraction = (rounded % scale).toString().padStart(8, '0').replace(/0+$/, '');
  const label = `${rounded / scale}${fraction ? `.${fraction}` : ''}`;
  return `${rounded * 10_000_000_000n === wad ? '' : 'about '}${label}`;
}
