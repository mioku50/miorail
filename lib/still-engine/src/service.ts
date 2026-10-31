// The one Mirror engine every surface calls: the page's API, link previews and agent tools.
//
// Caches only what was learned: the universe for minutes, a complete report for seconds, a
// verified name for minutes. A failed read is never cached. Concurrent questions about the same
// wallet share one read.

import type { Address } from 'viem';
import type { CalendarRead, CalendarSource } from './calendar.js';
import { computeMirror, type MirrorInput } from './mirror.js';
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

/** A report with the chain reading it was computed from, so a scenario can use the same block. */
export type MirrorReadingV1 =
  | { outcome: 'report'; report: MirrorReport; input: MirrorInput; cached: boolean }
  | { outcome: 'chain_unavailable'; attempts: readonly ProviderAttempt[] };

interface Reading {
  report: MirrorReport;
  input: MirrorInput;
}

export interface MirrorServiceOptions {
  providers: readonly Provider[];
  names: Names | null;
  /** When each stock reports earnings. It keeps its own clock; a stock without a date counts at the earnings rate. */
  calendar: CalendarSource;
  universeTtlMs?: number;
  reportTtlMs?: number;
  nameTtlMs?: number;
  now?: () => Date;
}

export interface MirrorService {
  check(input: string): Promise<MirrorOutcome>;
  /** One address's report and its reading, for what-if questions about that same block. */
  reading(address: Address): Promise<MirrorReadingV1>;
  /** The earnings calendar the reports are computed with, for the terms tool. */
  earnings(): Promise<CalendarRead>;
}

export function createMirrorService(options: MirrorServiceOptions): MirrorService {
  const { providers, names, calendar } = options;
  const universeTtlMs = options.universeTtlMs ?? 10 * 60_000;
  const reportTtlMs = options.reportTtlMs ?? 20_000;
  const nameTtlMs = options.nameTtlMs ?? 10 * 60_000;
  const now = options.now ?? (() => new Date());
  const age = (at: number) => now().getTime() - at;

  let universe: { value: Universe; at: number } | null = null;
  let loading: Promise<Universe> | null = null;
  const reports = new Map<Address, Reading & { at: number }>();
  const inflight = new Map<Address, Promise<Reading>>();
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

  async function read(address: Address): Promise<Reading> {
    // The calendar never rejects: a failed read comes back as "unread".
    const dates = calendar.current();
    const u = await currentUniverse();
    const snapshot = await readWallet(providers, u, address);
    const input: MirrorInput = { universe: u, snapshot, calendar: await dates, subject: { address, name: null, input: address }, assembledAt: now() };
    return { report: computeMirror(input), input };
  }

  async function readingFor(address: Address): Promise<MirrorReadingV1> {
    const hit = reports.get(address);
    if (hit && age(hit.at) < reportTtlMs) return { outcome: 'report', report: hit.report, input: hit.input, cached: true };
    let pending = inflight.get(address);
    if (!pending) {
      pending = read(address).finally(() => inflight.delete(address));
      inflight.set(address, pending);
    }
    try {
      const reading = await pending;
      if (reading.report.headline.complete) remember(reports, address, { ...reading, at: now().getTime() });
      return { outcome: 'report', ...reading, cached: false };
    } catch (error) {
      if (error instanceof ChainUnavailable) return { outcome: 'chain_unavailable', attempts: error.attempts };
      throw error;
    }
  }

  async function reportFor(address: Address): Promise<ReadOutcome> {
    const reading = await readingFor(address);
    return reading.outcome === 'report' ? { outcome: 'report', report: reading.report, cached: reading.cached } : reading;
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
    earnings: () => calendar.current(),
    reading: readingFor,
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
