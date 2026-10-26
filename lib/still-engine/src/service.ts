// The one Mirror engine every surface calls: the page's API, link previews and agent tools.
//
// Caches only what was learned: the universe for minutes, a complete report for seconds, a
// verified name for minutes. A failed read is never cached. Concurrent questions about the same
// wallet share one read.

import type { Address } from 'viem';
import type { CalendarRead, CalendarSource } from './calendar.js';
import { createDividendSource, type DividendSource } from './dividends.js';
import type { DividendReport } from './dividend-report.js';
import { createFoundSource, type FoundSource } from './found.js';
import type { FoundReport } from './found-report.js';
import { computeMirror } from './mirror.js';
import { loadUniverse, readWallet, type Universe } from './read.js';
import type { MirrorReport } from './report.js';
import { ChainUnavailable, type Provider, type ProviderAttempt } from './rpc.js';
import { parseSubject, resolveSubject, type Names, type ParsedSubject } from './subject.js';

export type MirrorOutcome =
  | { outcome: 'report'; report: MirrorReport; cached: boolean }
  | { outcome: 'invalid_subject'; input: string; reason: Extract<ParsedSubject, { kind: 'invalid' }>['reason'] }
  | { outcome: 'name_not_found'; input: string; name: string }
  | { outcome: 'names_unavailable'; input: string; name: string }
  | { outcome: 'chain_unavailable'; attempts: readonly ProviderAttempt[] };

type ReadOutcome = Extract<MirrorOutcome, { outcome: 'report' | 'chain_unavailable' }>;
export type FoundOutcome = Exclude<MirrorOutcome, { outcome: 'report' | 'chain_unavailable' }>
  | { outcome: 'found'; report: FoundReport; pollAfterSeconds: number | null }
  | { outcome: 'paused' }
  | { outcome: 'busy'; retryAfterSeconds: number };

export interface MirrorServiceOptions {
  providers: readonly Provider[];
  names: Names | null;
  /** When each stock reports earnings. It keeps its own clock; a stock without a date counts at the earnings rate. */
  calendar: CalendarSource;
  dividends?: DividendSource;
  found?: FoundSource;
  /** Off at server boot unless explicitly enabled after an RPC budget review. */
  foundEnabled?: boolean;
  universeTtlMs?: number;
  reportTtlMs?: number;
  nameTtlMs?: number;
  now?: () => Date;
}

export interface MirrorService {
  check(input: string): Promise<MirrorOutcome>;
  /** The earnings calendar the reports are computed with, for the terms tool. */
  earnings(): Promise<CalendarRead>;
  /** Public per-share declarations and verified token adjustments, never a wallet payment. */
  dividends(): Promise<DividendReport>;
  /** Start or poll a bounded, read-only LP token check. Does not read the borrowing line. */
  found(input: string): Promise<FoundOutcome>;
}

export function createMirrorService(options: MirrorServiceOptions): MirrorService {
  const { providers, names, calendar } = options;
  const dividends = options.dividends ?? createDividendSource({ providers, now: options.now });
  const found = options.found ?? createFoundSource({ providers, now: options.now });
  const universeTtlMs = options.universeTtlMs ?? 10 * 60_000;
  const reportTtlMs = options.reportTtlMs ?? 20_000;
  const nameTtlMs = options.nameTtlMs ?? 10 * 60_000;
  const now = options.now ?? (() => new Date());
  const age = (at: number) => now().getTime() - at;

  let universe: { value: Universe; at: number } | null = null;
  let loading: Promise<Universe> | null = null;
  const reports = new Map<Address, { report: MirrorReport; at: number }>();
  const inflight = new Map<Address, Promise<MirrorReport>>();
  const primaryNames = new Map<Address, { name: string | null; at: number }>();

  function remember<K, V>(cache: Map<K, V>, key: K, value: V) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > 5_000) cache.delete(cache.keys().next().value!);
  }

  async function currentUniverse(): Promise<Universe> {
    if (universe && age(universe.at) < universeTtlMs) return universe.value;
    loading ??= loadUniverse(providers)
      .then((value) => {
        // A venue that could not be read is not remembered: the next question asks again. A venue
        // that answered something we refuse (a new oracle, a different market) stays refused.
        const unread =
          (!value.aave.ok && value.aave.problem === 'unreadable') || value.morpho.some((m) => !m.ok && m.problem === 'unreadable');
        if (!unread) universe = { value, at: now().getTime() };
        return value;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  async function read(address: Address): Promise<MirrorReport> {
    // The calendar never rejects: a failed read comes back as "unread".
    const dates = calendar.current();
    const u = await currentUniverse();
    const snapshot = await readWallet(providers, u, address);
    return computeMirror({ universe: u, snapshot, calendar: await dates, subject: { address, name: null, input: address }, assembledAt: now() });
  }

  async function reportFor(address: Address): Promise<ReadOutcome> {
    const hit = reports.get(address);
    if (hit && age(hit.at) < reportTtlMs) return { outcome: 'report', report: hit.report, cached: true };
    let pending = inflight.get(address);
    if (!pending) {
      pending = read(address).finally(() => inflight.delete(address));
      inflight.set(address, pending);
    }
    try {
      const report = await pending;
      if (report.headline.complete) remember(reports, address, { report, at: now().getTime() });
      return { outcome: 'report', report, cached: false };
    } catch (error) {
      if (error instanceof ChainUnavailable) return { outcome: 'chain_unavailable', attempts: error.attempts };
      throw error;
    }
  }

  async function primaryName(address: Address): Promise<string | null> {
    const hit = primaryNames.get(address);
    if (hit && age(hit.at) < nameTtlMs) return hit.name;
    const resolution = await resolveSubject({ kind: 'address', input: address, address }, names);
    const name = resolution.ok ? resolution.name : null;
    if (name !== null) remember(primaryNames, address, { name, at: now().getTime() });
    return name;
  }

  const withSubject = (outcome: ReadOutcome, subject: MirrorReport['subject']): MirrorOutcome =>
    outcome.outcome === 'report' ? { ...outcome, report: { ...outcome.report, subject } } : outcome;

  return {
    async found(raw) {
      const parsed = parseSubject(raw);
      if (parsed.kind === 'invalid') return { outcome: 'invalid_subject', input: parsed.input, reason: parsed.reason };
      if (options.foundEnabled === false) return { outcome: 'paused' };
      let address: Address;
      if (parsed.kind === 'address') address = parsed.address;
      else {
        const resolved = await resolveSubject(parsed, names);
        if (!resolved.ok) return { outcome: resolved.reason === 'unresolved' ? 'name_not_found' : 'names_unavailable', input: parsed.input, name: parsed.name };
        address = resolved.address;
      }
      const report = found.current(address);
      return report ? { outcome: 'found', report, pollAfterSeconds: report.state === 'queued' || report.state === 'reading' ? 5 : null }
        : { outcome: 'busy', retryAfterSeconds: 15 };
    },
    dividends: () => dividends.current(),
    earnings: () => calendar.current(),
    async check(raw) {
      const parsed = parseSubject(raw);
      if (parsed.kind === 'invalid') return { outcome: 'invalid_subject', input: parsed.input, reason: parsed.reason };
      if (parsed.kind === 'address') {
        // The read needs no lookup; the display name is fetched alongside it.
        const [outcome, name] = await Promise.all([reportFor(parsed.address), primaryName(parsed.address)]);
        return withSubject(outcome, { address: parsed.address, name, input: parsed.input });
      }
      const resolution = await resolveSubject(parsed, names);
      if (!resolution.ok) {
        return resolution.reason === 'unresolved'
          ? { outcome: 'name_not_found', input: parsed.input, name: parsed.name }
          : { outcome: 'names_unavailable', input: parsed.input, name: parsed.name };
      }
      const outcome = await reportFor(resolution.address);
      return withSubject(outcome, { address: resolution.address, name: resolution.name, input: parsed.input });
    },
  };
}
