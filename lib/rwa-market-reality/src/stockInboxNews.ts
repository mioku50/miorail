import { stockInboxGroupKeyV1 } from '@mioagent/route-storage/stock-inbox';
import type { RwaSignalCardV1 } from '@mioagent/rwa-dossier/discover';

/** An issuer transaction is one personal update, backed by all its raw signals.
 * Equal values in DIFFERENT transactions or contracts never become one story. */
export function stockInboxNewsV1(cards: readonly RwaSignalCardV1[], coinbase: ReadonlySet<string>) {
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
    let headline: string | null = null,
      summary: string | null = null;
    if (issuerTransaction && updates.size) {
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
      summary = parts.join(' ');
      for (const text of new Set(
        rows
          .filter((row) => row.kind === 'official_asset_corporate_action_announced')
          .map((row) => row.facts.description)
          .filter((text): text is string => typeof text === 'string' && text.length > 0),
      )) {
        summary += ` Issuer announcement: “${text}”.`;
      }
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

function multiplierLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const wad = BigInt(value),
    scale = 100_000_000n;
  const rounded = (wad + 5_000_000_000n) / 10_000_000_000n;
  const fraction = (rounded % scale).toString().padStart(8, '0').replace(/0+$/, '');
  const label = `${rounded / scale}${fraction ? `.${fraction}` : ''}`;
  return `${rounded * 10_000_000_000n === wad ? '' : 'about '}${label}`;
}
