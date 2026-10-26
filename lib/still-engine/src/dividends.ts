// Public stock facts, independent of any wallet. Current scale reads share one block; a
// receipt requires an adjacent-block change AND the issuer's Cash Dividend announcement.
// History is found by bounded archive reads, never by scanning wide log ranges.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeEventLog, formatUnits, parseAbi, parseUnits } from 'viem';
import { aaveOracleAbi, multicall3Abi } from './abi.js';
import { createDividendCalendar, type DividendCalendarSource } from './dividend-calendar.js';
import type { DividendDeclaration, DividendReceipt, DividendReport } from './dividend-report.js';
import { loadUniverse, type Universe } from './read.js';
import { marketDate } from './policy.js';
import { ADDRESSES, STOCKS, type StockAsset } from './registry.js';
import { Batch, type Provider } from './rpc.js';

export interface DividendSource {
  current(): Promise<DividendReport>;
}
export interface DividendOptions {
  providers: readonly Provider[];
  calendar?: DividendCalendarSource;
  dataDir?: string;
  now?: () => Date;
  ttlMs?: number;
  historyBudgetMs?: number;
}
const WAD = 10n ** 18n;
export const stockMultiplierAbi = parseAbi([
  'function multiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
]);
const announcementAbi = parseAbi([
  'event Announcement(address indexed caller,string id,string description,string uri)',
  'event EndAnnouncement(string id)',
]);
const scaleEventAbi = parseAbi([
  'event MultiplierUpdated(uint256 multiplier)',
  'event UIMultiplierUpdated(uint256 oldMultiplier,uint256 newMultiplier,uint256 effectiveAtTimestamp)',
]);
const distributionEvents = parseAbi([
  'event Announcement(address indexed caller,string id,string description,string uri)',
  'event EndAnnouncement(string id)',
  'event MultiplierUpdated(uint256 multiplier)',
  'event UIMultiplierUpdated(uint256 oldMultiplier,uint256 newMultiplier,uint256 effectiveAtTimestamp)',
]);
interface Point {
  number: bigint;
  timestamp: bigint;
  hash: string;
}

async function fallback<T>(providers: readonly Provider[], read: (provider: Provider) => Promise<T>): Promise<T> {
  for (const provider of providers) {
    try {
      return await read(provider);
    } catch {
      /* No raw RPC errors escape: they include credentials. */
    }
  }
  throw new Error('dividend history unread');
}

async function block(providers: readonly Provider[], number?: bigint, finalized = false): Promise<Point> {
  return fallback(providers, async (provider) => {
    const value = await provider.client.getBlock(
      number === undefined ? { blockTag: finalized ? 'finalized' : 'latest' } : { blockNumber: number },
    );
    if (value.number === null || !value.hash) throw new Error('block unread');
    return { number: value.number, timestamp: value.timestamp, hash: value.hash };
  });
}

/** Interpolation is only an optimization. Bounds, monotone time and adjacent blocks decide. */
export async function blockBefore(providers: readonly Provider[], timestamp: bigint, head: Point): Promise<Point> {
  if (timestamp >= head.timestamp) return head;
  let left = await block(providers, 0n),
    right = head;
  if (timestamp < left.timestamp) throw new Error('date precedes Base');
  for (let i = 0; left.number + 1n < right.number && i < 80; i++) {
    const span = right.timestamp - left.timestamp;
    let at =
      span > 0n ? left.number + ((timestamp - left.timestamp) * (right.number - left.number)) / span : (left.number + right.number) / 2n;
    at = at <= left.number ? left.number + 1n : at >= right.number ? right.number - 1n : at;
    const point = await block(providers, at);
    if (point.timestamp < left.timestamp || point.timestamp > right.timestamp) throw new Error('non-monotone block time');
    if (point.timestamp <= timestamp) left = point;
    else right = point;
  }
  if (left.number + 1n !== right.number) throw new Error('block lookup budget exceeded');
  return left;
}

async function multiplier(providers: readonly Provider[], stock: StockAsset, at: bigint): Promise<bigint> {
  const batch = new Batch();
  const slot = batch.add(stock.token, stockMultiplierAbi, 'multiplier', []);
  await batch.run(providers, at);
  if (!slot.outcome.ok || slot.outcome.value <= 0n) throw new Error('historical multiplier unread');
  return slot.outcome.value;
}

const emptyReceipt = (reason: DividendReceipt['reason'], declaration: DividendDeclaration | null, unread = false): DividendReceipt => ({
  state: unread ? 'unread' : 'not_verified',
  reason,
  declaration,
  searched: null,
  proof: null,
});

/** Price is per raw token. Divide by the NEW multiplier before valuing extra underlying shares. */
export function reinvestment(before: bigint, after: bigint, rawPrice: bigint, oracleDecimals: number, declaredUsd: string) {
  if (before <= 0n || after <= before || rawPrice <= 0n || oracleDecimals < 0 || oracleDecimals > 18)
    throw new Error('unread reinvestment inputs');
  const declared = parseUnits(declaredUsd, 18);
  if (declared <= 0n) throw new Error('dividend amount is not positive');
  const added = ((after - before) * WAD) / before;
  const dollars = ((after - before) * rawPrice * 10n ** BigInt(18 - oracleDecimals) * WAD) / (before * after);
  return {
    addedSharesPerShare: formatUnits(added, 18),
    reinvestedUsdPerShare: formatUnits(dollars, 18),
    ofDeclaredBps: Number((dollars * 10_000n) / declared),
  };
}

export async function readDividendReceipt(
  providers: readonly Provider[],
  universe: Universe,
  stock: StockAsset,
  declaration: DividendDeclaration,
  head: Point,
): Promise<DividendReceipt> {
  if (!declaration.paymentDate || !universe.aave.ok) return emptyReceipt('history_unread', declaration, true);
  const reserve = universe.aave.reserves.find((r) => r.role.kind === 'stock' && r.role.asset.id === stock.id);
  if (!reserve) return emptyReceipt('history_unread', declaration, true);
  // The day before payment through 15 days after it is disclosed as a bounded window,
  // never described as the token's entire history.
  const fromSeconds = BigInt(Date.parse(`${declaration.paymentDate}T00:00:00Z`) / 1000) - 86_400n;
  const toSeconds = fromSeconds + 16n * 86_400n;
  let left = await blockBefore(providers, fromSeconds, head);
  let right = await blockBefore(providers, toSeconds, head);
  const searched = {
    from: new Date(Number(left.timestamp) * 1000).toISOString(),
    to: new Date(Number(right.timestamp) * 1000).toISOString(),
  };
  const before = await multiplier(providers, stock, left.number),
    last = await multiplier(providers, stock, right.number);
  if (before === last) return { ...emptyReceipt('no_net_change_in_window', declaration), searched };
  // Even a non-monotone history ends at an observed adjacent pair. We do not claim this is
  // the only change in the window or add an unverified series of changes together.
  while (left.number + 1n < right.number) {
    const at = (left.number + right.number) / 2n;
    const value = await multiplier(providers, stock, at);
    if (value === before) left = { ...left, number: at };
    else right = { ...right, number: at };
  }
  return proveDividendAtBlock(providers, universe, stock, declaration, right.number, searched);
}

async function proveDividendAtBlock(
  providers: readonly Provider[],
  universe: Universe,
  stock: StockAsset,
  declaration: DividendDeclaration,
  at: bigint,
  searched: DividendReceipt['searched'],
): Promise<DividendReceipt> {
  if (!universe.aave.ok || at <= 0n) throw new Error('receipt venue unread');
  const reserve = universe.aave.reserves.find((r) => r.role.kind === 'stock' && r.role.asset.id === stock.id);
  if (!reserve) throw new Error('receipt reserve unread');
  const applied = await block(providers, at);
  const batch = new Batch();
  const prior = batch.add(stock.token, stockMultiplierAbi, 'multiplier', []);
  await batch.run(providers, at - 1n);
  const actualBefore = prior.outcome.ok ? prior.outcome.value : null;
  const proofBatch = new Batch();
  const after = proofBatch.add(stock.token, stockMultiplierAbi, 'multiplier', []);
  const price = proofBatch.add(ADDRESSES.aaveOracle, aaveOracleAbi, 'getReservePrice', [BigInt(reserve.reserveId)]);
  await proofBatch.run(providers, at);
  if (!actualBefore || !after.outcome.ok) throw new Error('receipt multipliers unread');
  const actualAfter = after.outcome.value;
  const logs = await fallback(providers, (p) =>
    p.client.getLogs({ address: stock.token, events: distributionEvents, fromBlock: at, toBlock: at }),
  );
  const announcements = logs.flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: announcementAbi, data: log.data, topics: log.topics });
      return event.eventName === 'Announcement' && event.args.description.trim().toLowerCase() === 'cash dividend' && log.transactionHash
        ? [{ event, transactionHash: log.transactionHash, logIndex: log.logIndex }]
        : [];
    } catch {
      return [];
    }
  });
  if (announcements.length !== 1 || actualAfter <= actualBefore) return { ...emptyReceipt('dividend_not_verified', declaration), searched };
  const announcement = announcements[0]!;
  // The same transaction must bracket the actual scale change, rather than an unrelated
  // dividend announcement elsewhere in the block.
  const changes = logs.flatMap((log) => {
    try {
      return [
        {
          event: decodeEventLog({ abi: scaleEventAbi, data: log.data, topics: log.topics }),
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        },
      ];
    } catch {
      return [];
    }
  });
  const legacy = changes.filter((c) => c.event.eventName === 'MultiplierUpdated');
  const modern = changes.filter((c) => c.event.eventName === 'UIMultiplierUpdated');
  const closing = logs.find((log) => {
    if (log.transactionHash !== announcement.transactionHash) return false;
    try {
      const event = decodeEventLog({ abi: announcementAbi, data: log.data, topics: log.topics });
      return event.eventName === 'EndAnnouncement' && event.args.id === announcement.event.args.id;
    } catch {
      return false;
    }
  });
  const matches =
    changes.length > 0 &&
    legacy.length <= 1 &&
    modern.length <= 1 &&
    changes.every((c) => {
      if (
        c.transactionHash !== announcement.transactionHash ||
        c.logIndex === null ||
        announcement.logIndex === null ||
        closing?.logIndex == null ||
        c.logIndex <= announcement.logIndex ||
        c.logIndex >= closing.logIndex
      )
        return false;
      return c.event.eventName === 'MultiplierUpdated'
        ? c.event.args.multiplier === actualAfter
        : c.event.args.oldMultiplier === actualBefore &&
            c.event.args.newMultiplier === actualAfter &&
            c.event.args.effectiveAtTimestamp <= applied.timestamp;
    });
  if (!matches) return { ...emptyReceipt('dividend_not_verified', declaration), searched };
  return {
    state: 'verified',
    reason: null,
    declaration,
    searched,
    proof: {
      block: applied.number.toString(),
      blockHash: applied.hash,
      blockTime: new Date(Number(applied.timestamp) * 1000).toISOString(),
      transactionHash: announcement.transactionHash,
      announcementId: announcement.event.args.id,
      multiplierBeforeWad: actualBefore.toString(),
      multiplierAfterWad: actualAfter.toString(),
      oraclePrice: price.outcome.ok && price.outcome.value > 0n ? price.outcome.value.toString() : null,
      oracleDecimals: universe.aave.oracleDecimals,
      ...(price.outcome.ok && price.outcome.value > 0n
        ? reinvestment(actualBefore, actualAfter, price.outcome.value, universe.aave.oracleDecimals, declaration.amountUsd)
        : {
            addedSharesPerShare: formatUnits(((actualAfter - actualBefore) * WAD) / actualBefore, 18),
            reinvestedUsdPerShare: null,
            ofDeclaredBps: null,
          }),
    },
  };
}

export function unreadDividendReport(): DividendReport {
  return {
    kind: 'still.dividends',
    version: 1,
    reading: null,
    calendarReadAt: null,
    calendarSince: null,
    stocks: STOCKS.map((stock) => ({
      asset: stock.id,
      name: stock.name,
      token: stock.token,
      calendar: 'unread',
      next: { state: 'unread', declaration: null },
      adjustment: { state: 'unread', currentMultiplierWad: null, nextMultiplierWad: null, effectiveAt: null },
      receipt: emptyReceipt('history_unread', null, true),
    })),
    coverage: {
      total: STOCKS.length,
      calendarsRead: 0,
      adjustmentsRead: 0,
      receiptsVerified: 0,
      receiptsPriced: 0,
      receiptsUnread: STOCKS.length,
    },
  };
}

export function createDividendSource(options: DividendOptions): DividendSource {
  const { providers } = options;
  const now = options.now ?? (() => new Date());
  const calendar = options.calendar ?? createDividendCalendar({ now });
  const receipts = new Map<string, DividendReceipt>();
  // The disk cache is a locator, never authority. Re-prove its block from the chain once
  // per process, then reuse that measured receipt in memory.
  const locations = new Map<string, { block: bigint; hash: string }>();
  const receiptLoading = new Map<string, Promise<DividendReceipt>>();
  let loaded = false;
  let cache: { report: DividendReport; until: number } | null = null;
  let loading: Promise<DividendReport> | null = null;

  async function loadCache() {
    if (loaded) return;
    loaded = true;
    if (!options.dataDir) return;
    try {
      const data: unknown = JSON.parse(await readFile(join(options.dataDir, 'dividend-receipts-v1.json'), 'utf8'));
      if (
        !data ||
        typeof data !== 'object' ||
        !('version' in data) ||
        data.version !== 1 ||
        !('entries' in data) ||
        !Array.isArray(data.entries)
      )
        return;
      for (const entry of data.entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
        const receipt = entry[1] as DividendReceipt | undefined;
        if (
          receipt?.state === 'verified' &&
          receipt.proof &&
          /^\d+$/.test(receipt.proof.block) &&
          /^0x[\da-f]{64}$/i.test(receipt.proof.blockHash)
        )
          locations.set(entry[0], { block: BigInt(receipt.proof.block), hash: receipt.proof.blockHash });
      }
    } catch {
      /* A missing or damaged cache is never treated as a receipt. */
    }
  }

  async function persist() {
    if (!options.dataDir) return;
    try {
      await mkdir(options.dataDir, { recursive: true });
      const file = join(options.dataDir, 'dividend-receipts-v1.json');
      await writeFile(
        `${file}.tmp`,
        JSON.stringify({
          version: 1,
          entries: [...locations].map(([key, value]) => [
            key,
            { state: 'verified', proof: { block: value.block.toString(), blockHash: value.hash } },
          ]),
        }) + '\n',
        { mode: 0o600 },
      );
      await rename(`${file}.tmp`, file);
    } catch {
      /* The measured report is still usable; only restart caching is unavailable. */
    }
  }

  async function read(): Promise<DividendReport> {
    await loadCache();
    const dates = calendar.current().catch(() => null);
    const head = await block(providers);
    const batch = new Batch();
    const number = batch.add(ADDRESSES.multicall3, multicall3Abi, 'getBlockNumber', []);
    const timestamp = batch.add(ADDRESSES.multicall3, multicall3Abi, 'getCurrentBlockTimestamp', []);
    const slots = STOCKS.map((stock) => ({
      stock,
      current: batch.add(stock.token, stockMultiplierAbi, 'multiplier', []),
      next: batch.add(stock.token, stockMultiplierAbi, 'newUIMultiplier', []),
      at: batch.add(stock.token, stockMultiplierAbi, 'effectiveAt', []),
    }));
    const reading = await batch.run(providers, head.number);
    if (!number.outcome.ok || !timestamp.outcome.ok || number.outcome.value !== head.number || timestamp.outcome.value !== head.timestamp)
      throw new Error('dividend snapshot disagrees');
    const entries = await dates;
    const report = unreadDividendReport();
    report.reading = {
      block: head.number.toString(),
      blockTime: new Date(Number(head.timestamp) * 1000).toISOString(),
      provider: reading.provider,
    };
    report.calendarReadAt = entries?.readAt ?? null;
    report.calendarSince = entries?.since ?? null;
    let universe: Universe | null = null,
      historicalHead: Point | null = null;
    const deadline = Date.now() + (options.historyBudgetMs ?? 15_000);
    for (const { stock, current, next, at } of slots) {
      const row = report.stocks.find((s) => s.asset === stock.id)!;
      if (current.outcome.ok && next.outcome.ok && at.outcome.ok && current.outcome.value > 0n && next.outcome.value > 0n) {
        const scheduled = at.outcome.value > head.timestamp;
        row.adjustment = {
          state: scheduled ? 'scheduled' : 'none',
          currentMultiplierWad: current.outcome.value.toString(),
          nextMultiplierWad: scheduled ? next.outcome.value.toString() : null,
          effectiveAt: scheduled ? new Date(Number(at.outcome.value) * 1000).toISOString() : null,
        };
      }
      const declarations = entries?.stocks.get(stock.id);
      if (declarations === undefined) continue;
      row.calendar = 'read';
      const today = marketDate(new Date(Number(head.timestamp) * 1000));
      const byPayment = [...declarations].sort((a, b) => (a.paymentDate ?? a.exDate).localeCompare(b.paymentDate ?? b.exDate));
      const future = byPayment.find((d) => (d.paymentDate ?? d.exDate) >= today);
      row.next = {
        state: future ? 'announced' : declarations.length ? 'not_announced' : 'no_dividends_listed',
        declaration: future ?? null,
      };
      const past = [...byPayment].reverse().find((d) => d.paymentDate && d.paymentDate <= today);
      if (!past) {
        row.receipt = emptyReceipt('no_payment_in_calendar', null);
        continue;
      }
      if (row.adjustment.currentMultiplierWad === WAD.toString()) {
        row.receipt = emptyReceipt('not_measured', past);
        continue;
      }
      const paymentAt = Date.parse(`${past.paymentDate}T00:00:00Z`);
      if (
        declarations.some(
          (d) => d !== past && d.paymentDate && Math.abs(Date.parse(`${d.paymentDate}T00:00:00Z`) - paymentAt) <= 16 * 86_400_000,
        )
      ) {
        row.receipt = emptyReceipt('ambiguous_calendar', past);
        continue;
      }
      const key = `8453:${stock.token.toLowerCase()}:${past.exDate}:${past.paymentDate}:${past.amountUsd}`;
      const hit = receipts.get(key);
      if (hit) {
        row.receipt = hit;
        continue;
      }
      if (Date.now() >= deadline || row.adjustment.state === 'unread') {
        row.receipt = emptyReceipt('history_unread', past, true);
        continue;
      }
      let task = receiptLoading.get(key);
      if (!task) {
        task = (async () => {
          universe ??= await loadUniverse(providers);
          historicalHead ??= await block(providers, undefined, true);
          const location = locations.get(key);
          let receipt: DividendReceipt;
          if (location) {
            const point = await block(providers, location.block);
            const inWindow =
              Number(point.timestamp) * 1000 >= paymentAt - 86_400_000 && Number(point.timestamp) * 1000 <= paymentAt + 15 * 86_400_000;
            receipt =
              point.hash === location.hash && inWindow
                ? await proveDividendAtBlock(providers, universe, stock, past, location.block, null)
                : await readDividendReceipt(providers, universe, stock, past, historicalHead);
          } else receipt = await readDividendReceipt(providers, universe, stock, past, historicalHead);
          if (receipt.state === 'verified') {
            if (receipt.proof && receipt.proof.reinvestedUsdPerShare !== null) receipts.set(key, receipt);
            if (receipt.proof) locations.set(key, { block: BigInt(receipt.proof.block), hash: receipt.proof.blockHash });
            await persist();
          }
          return receipt;
        })()
          .catch(() => emptyReceipt('history_unread', past, true))
          .finally(() => receiptLoading.delete(key));
        receiptLoading.set(key, task);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      row.receipt = await Promise.race([
        task,
        new Promise<DividendReceipt>((resolve) => {
          timer = setTimeout(() => resolve(emptyReceipt('history_unread', past, true)), Math.max(1, deadline - Date.now()));
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    report.coverage = {
      total: STOCKS.length,
      calendarsRead: report.stocks.filter((s) => s.calendar === 'read').length,
      adjustmentsRead: report.stocks.filter((s) => s.adjustment.state !== 'unread').length,
      receiptsVerified: report.stocks.filter((s) => s.receipt.state === 'verified').length,
      receiptsPriced: report.stocks.filter(
        (s) => s.receipt.state === 'verified' && s.receipt.proof && s.receipt.proof.reinvestedUsdPerShare !== null,
      ).length,
      receiptsUnread: report.stocks.filter((s) => s.receipt.state === 'unread').length,
    };
    return report;
  }
  return {
    current() {
      if (cache && cache.until > now().getTime()) return Promise.resolve(cache.report);
      loading ??= read()
        .catch(() => unreadDividendReport())
        .then((report) => {
          const complete =
            report.coverage.calendarsRead === STOCKS.length &&
            report.coverage.adjustmentsRead === STOCKS.length &&
            report.coverage.receiptsUnread === 0;
          const scheduled = report.stocks.flatMap((s) => (s.adjustment.effectiveAt ? [Date.parse(s.adjustment.effectiveAt)] : []));
          const until = Math.min(now().getTime() + (complete ? (options.ttlMs ?? 300_000) : 30_000), ...scheduled);
          cache = { report, until };
          return report;
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    },
  };
}
