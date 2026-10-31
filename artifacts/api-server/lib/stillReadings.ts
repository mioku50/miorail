import type { MirrorReport } from '@mioagent/still-engine/report';
import { formatCents, formatPercentBps } from '@mioagent/still-engine/format';
import { logger } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// Earlier readings of a signed-in wallet's own Still report.
//
// "Why did my borrowing room go down?" has no honest answer from one reading:
// it needs the room as it was. Each time the person's own report is read for
// them, the figures that set the room are kept: prices, Still's shares, what
// each asset counted for, the debts, the venues' limits. Nothing that names a
// person beyond the wallet the session proved, and only for 60 days.
//
// A change is then explained by splitting each asset's part of the room into
// what its price did, what Still's share did (the market closing, an earnings
// window, new terms) and what the holding did, plus the debt and the venues.
// ---------------------------------------------------------------------------

type SqlV1 = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

export interface StoredStillReadingV1 {
  block: string;
  blockTime: string;
  termsVersion: string;
  marketClosed: boolean;
  availableCents: string | null;
  lines: Array<{
    asset: string;
    name: string;
    kind: 'stock' | 'crypto';
    priceCents: string | null;
    stillFactorBps: number | null;
    capacityCents: string | null;
    heldRaw: string | null;
    decimals: number;
    lowered: boolean;
  }>;
  venues: Array<{ venue: string; market: string; label: string; debtCents: string | null; venueLimitCents: string | null }>;
}

export function storedReadingOfV1(report: MirrorReport): StoredStillReadingV1 {
  return {
    block: report.reading.block,
    blockTime: report.reading.blockTime,
    termsVersion: report.terms.version,
    marketClosed: report.terms.weekend.active,
    availableCents: report.headline.availableCents,
    lines: report.assets.map((line) => {
      const held = [line.wallet, line.pledged];
      return {
        asset: line.asset,
        name: line.name,
        kind: line.kind,
        priceCents: line.priceCents,
        stillFactorBps: line.stillFactorBps,
        capacityCents: line.capacityCents,
        heldRaw: held.some((amount) => amount === null) ? null : held.reduce((sum, amount) => sum + BigInt(amount!.raw), 0n).toString(),
        decimals: line.wallet?.decimals ?? line.pledged?.decimals ?? 0,
        lowered: line.earnings?.lowered ?? false,
      };
    }),
    venues: report.venues.map((v) => ({ venue: v.venue, market: v.market, label: v.label, debtCents: v.debtCents, venueLimitCents: v.deductions.venueLimitCents })),
  };
}

export interface StillReadingStoreV1 {
  /** Keeps a reading unless one with the same room was kept in the last half hour. */
  record(wallet: string, reading: StoredStillReadingV1, now: Date): Promise<void>;
  /** Readings taken before `before`, newest first. */
  earlier(wallet: string, before: Date, limit: number): Promise<StoredStillReadingV1[]>;
}

const RETENTION_DAYS_V1 = 60;
const QUIET_MINUTES_V1 = 30;

export function createDatabaseStillReadingStoreV1(sql: SqlV1): StillReadingStoreV1 {
  return {
    async record(wallet, reading, now) {
      const at = now.toISOString();
      await sql`INSERT INTO still_wallet_readings
          (wallet_address, block_number, block_time, terms_version, market_closed, available_cents, reading_json, created_at)
        SELECT ${wallet}, ${reading.block}::bigint, ${reading.blockTime}::timestamptz, ${reading.termsVersion}, ${reading.marketClosed},
               ${reading.availableCents}::bigint, ${JSON.stringify(reading)}::text::jsonb, ${at}::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM still_wallet_readings
           WHERE wallet_address = ${wallet}
             AND created_at > ${at}::timestamptz - make_interval(mins => ${QUIET_MINUTES_V1})
             AND available_cents IS NOT DISTINCT FROM ${reading.availableCents}::bigint)`;
      await sql`DELETE FROM still_wallet_readings
        WHERE wallet_address = ${wallet} AND created_at < ${at}::timestamptz - make_interval(days => ${RETENTION_DAYS_V1})`;
    },
    async earlier(wallet, before, limit) {
      const rows = await sql`SELECT reading_json FROM still_wallet_readings
        WHERE wallet_address = ${wallet} AND block_time < ${before.toISOString()}::timestamptz
        ORDER BY block_time DESC LIMIT ${limit}`;
      return rows.map((row) => (typeof row.reading_json === 'string' ? JSON.parse(row.reading_json) : row.reading_json) as StoredStillReadingV1);
    },
  };
}

export function createMemoryStillReadingStoreV1(): StillReadingStoreV1 & { rows: Array<{ wallet: string; reading: StoredStillReadingV1; at: Date }> } {
  const rows: Array<{ wallet: string; reading: StoredStillReadingV1; at: Date }> = [];
  return {
    rows,
    async record(wallet, reading, now) {
      const quiet = rows.some((row) => row.wallet === wallet && now.getTime() - row.at.getTime() < QUIET_MINUTES_V1 * 60_000 && row.reading.availableCents === reading.availableCents);
      if (!quiet) rows.push({ wallet, reading, at: now });
    },
    async earlier(wallet, before, limit) {
      return rows
        .filter((row) => row.wallet === wallet && Date.parse(row.reading.blockTime) < before.getTime())
        .sort((a, b) => Date.parse(b.reading.blockTime) - Date.parse(a.reading.blockTime))
        .slice(0, limit)
        .map((row) => row.reading);
    },
  };
}

let databaseStore: StillReadingStoreV1 | null = null;
export const stillReadingsRuntimeV1 = {
  async store(): Promise<StillReadingStoreV1> {
    if (!databaseStore) {
      const { client } = await import('@mioagent/db');
      databaseStore = createDatabaseStillReadingStoreV1(client as unknown as SqlV1);
    }
    return databaseStore;
  },
  now: () => new Date(),
};

/** Keeps the reading the person was just shown. Never fails the page: a lost reading is a shorter history. */
export async function rememberStillReadingV1(wallet: string, report: MirrorReport): Promise<void> {
  try {
    if (report.headline.availableCents === null) return;
    await (await stillReadingsRuntimeV1.store()).record(wallet.toLowerCase(), storedReadingOfV1(report), stillReadingsRuntimeV1.now());
  } catch (error) {
    logger.warn('Still reading was not kept', { errorName: error instanceof Error ? error.name : typeof error });
  }
}

/** The reading to compare with: the latest at least a quarter of an hour old whose room differs, else the latest. */
export async function earlierStillReadingV1(wallet: string, report: MirrorReport): Promise<StoredStillReadingV1 | null> {
  try {
    const before = new Date(Date.parse(report.reading.blockTime) - 15 * 60_000);
    const earlier = await (await stillReadingsRuntimeV1.store()).earlier(wallet.toLowerCase(), before, 50);
    return earlier.find((reading) => reading.availableCents !== report.headline.availableCents) ?? earlier[0] ?? null;
  } catch (error) {
    logger.warn('Still readings could not be read', { errorName: error instanceof Error ? error.name : typeof error });
    return null;
  }
}

export interface StillReadingChangeV1 {
  /** The room then, in cents. */
  before: string;
  sinceText: { ru: string; en: string };
  /** One line per cause, largest first, each with the dollars it moved the room by. */
  causes: Array<{ ru: string; en: string }>;
}

const MOMENT_V1 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const signed = (cents: bigint) => `${cents < 0n ? '−' : '+'}${formatCents(cents < 0n ? -cents : cents)}`;

/** What moved the room between a stored reading and this report. The causes add up to the change. */
export function stillReadingChangeV1(previous: StoredStillReadingV1, report: MirrorReport): StillReadingChangeV1 | null {
  if (previous.availableCents === null || report.headline.availableCents === null) return null;
  const now = storedReadingOfV1(report);
  const when = MOMENT_V1.format(new Date(previous.blockTime)).replace(/,/g, '');
  const causes: Array<{ cents: bigint; ru: string; en: string }> = [];
  const add = (cents: bigint, ru: string, en: string) => {
    if (cents !== 0n) causes.push({ cents, ru: `${ru}: ${signed(cents)}.`, en: `${en}: ${signed(cents)}.` });
  };
  for (const after of now.lines) {
    const was = previous.lines.find((line) => line.asset === after.asset);
    const c1 = after.capacityCents === null ? null : BigInt(after.capacityCents);
    if (!was || was.capacityCents === null) {
      if (c1 !== null) add(c1, `${after.name}: новая позиция`, `${after.name}: a new holding`);
      continue;
    }
    const c0 = BigInt(was.capacityCents);
    if (c1 === null) continue;
    let rest = c1 - c0;
    if (was.priceCents && after.priceCents && BigInt(was.priceCents) > 0n) {
      const p0 = BigInt(was.priceCents);
      const p1 = BigInt(after.priceCents);
      const price = (c0 * (p1 - p0)) / p0;
      add(price, `Цена ${after.name} ${formatCents(p0)} → ${formatCents(p1)}`, `${after.name} price ${formatCents(p0)} → ${formatCents(p1)}`);
      rest -= price;
      if (was.stillFactorBps && after.stillFactorBps !== null && was.stillFactorBps !== after.stillFactorBps) {
        const share = (c0 * p1 * BigInt(after.stillFactorBps - was.stillFactorBps)) / (p0 * BigInt(was.stillFactorBps));
        const share0 = formatPercentBps(was.stillFactorBps, 2);
        const share1 = formatPercentBps(after.stillFactorBps, 2);
        const why =
          after.kind === 'stock' && now.marketClosed !== previous.marketClosed
            ? now.marketClosed
              ? { ru: `рынок США закрылся, ${after.name} считается по ${share1} вместо ${share0}`, en: `the US market closed, so ${after.name} counts at ${share1} instead of ${share0}` }
              : { ru: `рынок США открылся, ${after.name} считается по ${share1} вместо ${share0}`, en: `the US market opened, so ${after.name} counts at ${share1} instead of ${share0}` }
            : after.lowered !== was.lowered
              ? { ru: `окно отчётности ${after.name}: ${share0} → ${share1}`, en: `the ${after.name} earnings window: ${share0} → ${share1}` }
              : { ru: `доля Still для ${after.name}: ${share0} → ${share1}`, en: `Still’s share for ${after.name}: ${share0} → ${share1}` };
        const first = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        add(share, first(why.ru), first(why.en));
        rest -= share;
      }
    }
    if (was.heldRaw !== null && after.heldRaw !== null && was.heldRaw !== after.heldRaw) {
      add(rest, `${after.name}: в кошельке и залоге стало ${BigInt(after.heldRaw) > BigInt(was.heldRaw) ? 'больше' : 'меньше'}`, `${after.name}: you hold ${BigInt(after.heldRaw) > BigInt(was.heldRaw) ? 'more' : 'less'}`);
      rest = 0n;
    }
    if (rest !== 0n) add(rest, `${after.name}: лимиты площадки и округление`, `${after.name}: venue caps and rounding`);
  }
  for (const was of previous.lines) {
    if (!now.lines.some((line) => line.asset === was.asset) && was.capacityCents !== null) add(-BigInt(was.capacityCents), `${was.name}: больше не в кошельке`, `${was.name}: no longer held`);
  }
  const debt = (r: StoredStillReadingV1) => r.venues.reduce((sum, v) => sum + (v.debtCents === null ? 0n : BigInt(v.debtCents)), 0n);
  const debtChange = debt(now) - debt(previous);
  if (debtChange !== 0n) {
    add(-debtChange, debtChange > 0n ? 'Долг вырос (проценты или новый займ)' : 'Долг уменьшился', debtChange > 0n ? 'Debt grew (interest or a new loan)' : 'Debt went down');
  }
  // What the venues could lend, and Still's floors at zero, account for the rest.
  const explained = causes.reduce((sum, cause) => sum + cause.cents, 0n);
  const total = BigInt(report.headline.availableCents) - BigInt(previous.availableCents);
  add(total - explained, 'Сколько площадки могут дать сейчас', 'What the venues can lend now');
  causes.sort((a, b) => (a.cents < 0n ? -a.cents : a.cents) > (b.cents < 0n ? -b.cents : b.cents) ? -1 : 1);
  return {
    before: previous.availableCents,
    sinceText: { ru: `На чтении ${when} по Нью-Йорку`, en: `At the reading of ${when} New York time,` },
    causes: causes.map(({ ru, en }) => ({ ru, en })),
  };
}
