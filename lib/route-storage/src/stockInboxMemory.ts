import {
  StockInboxIdsV1Schema,
  StockInboxWalletV1Schema,
  stockInboxAboveCapV1,
  stockInboxGroupKeyV1,
  stockInboxPageV1,
  type StockInboxGroupV1,
  type StockInboxRepositoryV1,
  type StockInboxStateV1,
} from './stockInbox.js';
import type { RwaSignalRowV1 } from './rwaSignals.js';

export function createMemoryStockInboxRepositoryV1(
  signals: () => readonly RwaSignalRowV1[],
): StockInboxRepositoryV1 {
  const states = new Map<string, StockInboxStateV1>();
  const read = new Set<string>();
  return {
    async open(wallet, now) {
      StockInboxWalletV1Schema.parse(wallet);
      if (!states.has(wallet))
        states.set(wallet, {
          since: new Date(now.getTime() - 86_400_000).toISOString(),
          openedAt: now.toISOString(),
          reviewedAt: null,
        });
      return { ...states.get(wallet)! };
    },
    async page(input) {
      StockInboxWalletV1Schema.parse(input.wallet);
      const addresses = new Set(input.addresses);
      const rows = signals()
        .filter(
          (row) =>
            row.chainId === 8453 &&
            (addresses.has(row.subjectAddress) ||
              (row.officialAddress !== null && addresses.has(row.officialAddress))) &&
            Date.parse(row.recordedAt) >= Date.parse(input.since) &&
            Date.parse(row.recordedAt) <= Date.parse(input.until) &&
            Date.parse(row.occurredAt) <= Date.parse(input.until) &&
            !stockInboxAboveCapV1(row, input.sizeCaps),
        )
        .sort(
          (a, b) =>
            Date.parse(b.recordedAt) - Date.parse(a.recordedAt) ||
            (BigInt(a.signalId) > BigInt(b.signalId) ? -1 : 1),
        )
        .map((row) => ({ ...row, facts: { ...row.facts } }));
      const groups = new Map<string, StockInboxGroupV1>();
      for (const row of rows) {
        const key = stockInboxGroupKeyV1(row);
        const existing = groups.get(key);
        if (existing) existing.rows.push(row);
        else groups.set(key, { anchor: { at: row.recordedAt, id: row.signalId }, rows: [row] });
      }
      const visible = [...groups.values()].filter(
        (group) =>
          (input.view === 'history' ||
            group.rows.some((row) => !read.has(`${input.wallet}:${row.signalId}`))) &&
          (!input.before ||
            Date.parse(group.anchor.at) < Date.parse(input.before.at) ||
            (Date.parse(group.anchor.at) === Date.parse(input.before.at) &&
              BigInt(group.anchor.id) < BigInt(input.before.id))),
      );
      return stockInboxPageV1(visible.slice(0, 51));
    },
    async acknowledge(wallet, ids, now) {
      StockInboxWalletV1Schema.parse(wallet);
      StockInboxIdsV1Schema.parse(ids);
      const prior = states.get(wallet);
      if (!prior || ids.some((id) => !signals().some((row) => row.signalId === id)))
        throw new Error('stock_inbox_receipt_invalid');
      for (const id of ids) read.add(`${wallet}:${id}`);
      const next = {
        ...prior,
        reviewedAt: new Date(
          Math.max(Date.parse(prior.reviewedAt ?? prior.openedAt), now.getTime()),
        ).toISOString(),
      };
      states.set(wallet, next);
      return { ...next };
    },
  };
}
