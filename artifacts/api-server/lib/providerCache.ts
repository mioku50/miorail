// Provider orchestration layer: persistent TTL cache + in-flight de-duplication +
// per-provider call budget. Wraps expensive external provider calls so free limits
// are not burned by repeated frontend/API requests. Lives in the api-server so the
// @mioagent/data-providers package stays pure and DB-free.
//
// Safety: this module never sends API keys or private keys to providers (the fetcher
// closures own their own auth) and never executes transactions. A cache-store
// failure is treated as a cache miss/write miss: callers can still receive a real
// provider result, but production never substitutes an in-memory or fabricated
// payload when the database is unavailable.

import { db, providerCache } from '@mioagent/db';
import { getProviderBudgetErrorDetails } from '@mioagent/data-providers';
import { eq } from 'drizzle-orm';

export type CacheStatus = "live" | "cached" | "stale" | "failed" | "rate_limited" | "budget_exhausted";
export type ProviderName = "moralis" | "goplus" | "alchemy" | "coingecko" | "none";
export type BudgetStatus = "ok" | "rate-limited" | "disabled" | "rate_limited" | "budget_exhausted" | "auth_or_budget_issue";

export interface CacheEntry<T = unknown> {
  key: string;
  provider: ProviderName;
  chainId: number;
  payload: T;
  status: CacheStatus;
  createdAt: number; // ms epoch
  updatedAt: number; // ms epoch
  expiresAt: number; // ms epoch
  lastError?: string;
}

export interface ProviderCacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(entry: CacheEntry<T>): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CachedCallResult<T> {
  data: T | undefined;
  status: CacheStatus;
  cacheAgeSeconds?: number;
  fromCache: boolean;
  providerCalled: boolean;
  budgetExhausted: boolean;
  error?: string;
  errorCode?: string;
}

export interface ProviderBudgetSnapshot {
  provider?: ProviderName;
  status: BudgetStatus;
  callsLastMinute: number;
  callsLastHour: number;
  budgetExhausted?: boolean;
  lastErrorCode?: string;
  lastErrorAt?: string;
  cooldownUntil?: string;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// ---------------------------------------------------------------------------
// In-memory store used only through explicit test injection.
// ---------------------------------------------------------------------------

export class InMemoryProviderCacheStore implements ProviderCacheStore {
  private map = new Map<string, CacheEntry<any>>();

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    return (this.map.get(key) as CacheEntry<T> | undefined) ?? null;
  }
  async set<T>(entry: CacheEntry<T>): Promise<void> {
    this.map.set(entry.key, entry as CacheEntry<any>);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

class NoopProviderCacheStore implements ProviderCacheStore {
  async get<T>(_key: string): Promise<CacheEntry<T> | null> { return null; }
  async set<T>(_entry: CacheEntry<T>): Promise<void> { /* cache disabled */ }
  async delete(_key: string): Promise<void> { /* cache disabled */ }
}

// ---------------------------------------------------------------------------
// DB-backed store (provider_cache table). Errors propagate to the orchestration
// layer, which may still call the real provider but never returns invented data.
// ---------------------------------------------------------------------------

export class DbProviderCacheStore implements ProviderCacheStore {
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const rows = await db.select().from(providerCache).where(eq(providerCache.key, key)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
        key: row.key,
        provider: row.provider as ProviderName,
        chainId: row.chainId,
        payload: row.payload as T,
        status: row.status as CacheStatus,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        expiresAt: row.expiresAt.getTime(),
        lastError: row.lastError ?? undefined,
    };
  }

  async set<T>(entry: CacheEntry<T>): Promise<void> {
    const now = new Date();
    await db
        .insert(providerCache)
        .values({
          key: entry.key,
          provider: entry.provider,
          chainId: entry.chainId,
          payload: entry.payload as any,
          status: entry.status,
          lastError: entry.lastError ?? null,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(entry.expiresAt),
        })
        .onConflictDoUpdate({
          target: providerCache.key,
          set: {
            provider: entry.provider,
            chainId: entry.chainId,
            payload: entry.payload as any,
            status: entry.status,
            lastError: entry.lastError ?? null,
            updatedAt: now,
            expiresAt: new Date(entry.expiresAt),
          },
        });
  }

  async delete(key: string): Promise<void> {
    await db.delete(providerCache).where(eq(providerCache.key, key));
  }
}

// ---------------------------------------------------------------------------
// Per-provider call budget (rolling minute + hour windows)
// ---------------------------------------------------------------------------

export class ProviderBudget {
  private minuteHits = new Map<ProviderName, number[]>();
  private hourHits = new Map<ProviderName, number[]>();
  private remoteIssues = new Map<ProviderName, {
    status: Exclude<BudgetStatus, "ok" | "disabled" | "rate-limited">;
    errorCode: string;
    until: number;
    at: number;
  }>();

  constructor(
    private readonly maxPerMinute: number,
    private readonly maxPerHour: number,
    private readonly perProvider: Partial<Record<ProviderName, { maxPerMinute: number; maxPerHour: number }>> = {},
    private readonly now: () => number = Date.now,
  ) {}

  private limitsFor(provider: ProviderName): { maxPerMinute: number; maxPerHour: number } {
    return this.perProvider[provider] ?? { maxPerMinute: this.maxPerMinute, maxPerHour: this.maxPerHour };
  }

  private prune(provider: ProviderName, now: number): void {
    const m = this.minuteHits.get(provider);
    if (m) this.minuteHits.set(provider, m.filter((t) => now - t < MINUTE_MS));
    const h = this.hourHits.get(provider);
    if (h) this.hourHits.set(provider, h.filter((t) => now - t < HOUR_MS));
    const issue = this.remoteIssues.get(provider);
    if (issue !== undefined && issue.until <= now) this.remoteIssues.delete(provider);
  }

  canCall(provider: ProviderName): boolean {
    const { maxPerMinute, maxPerHour } = this.limitsFor(provider);
    if (maxPerMinute <= 0 || maxPerHour <= 0) return false;
    const now = this.now();
    this.prune(provider, now);
    if (this.getRemoteProviderIssue(provider)) return false;
    const m = this.minuteHits.get(provider)?.length ?? 0;
    const h = this.hourHits.get(provider)?.length ?? 0;
    return m < maxPerMinute && h < maxPerHour;
  }

  record(provider: ProviderName): void {
    const now = this.now();
    this.prune(provider, now);
    if (!this.minuteHits.has(provider)) this.minuteHits.set(provider, []);
    if (!this.hourHits.has(provider)) this.hourHits.set(provider, []);
    this.minuteHits.get(provider)!.push(now);
    this.hourHits.get(provider)!.push(now);
  }

  snapshot(provider: ProviderName): ProviderBudgetSnapshot {
    const { maxPerMinute, maxPerHour } = this.limitsFor(provider);
    if (maxPerMinute <= 0 || maxPerHour <= 0) {
      return { status: "disabled", callsLastMinute: 0, callsLastHour: 0 };
    }
    const now = this.now();
    this.prune(provider, now);
    const callsLastMinute = this.minuteHits.get(provider)?.length ?? 0;
    const callsLastHour = this.hourHits.get(provider)?.length ?? 0;
    const remoteIssue = this.getRemoteProviderIssue(provider);
    if (remoteIssue) {
      return {
        provider,
        status: remoteIssue.status,
        callsLastMinute,
        callsLastHour,
        budgetExhausted: true,
        lastErrorCode: remoteIssue.errorCode,
        lastErrorAt: new Date(remoteIssue.at).toISOString(),
        cooldownUntil: new Date(remoteIssue.until).toISOString(),
      };
    }
    const status: BudgetStatus = this.canCall(provider) ? "ok" : "rate-limited";
    return { provider, status, callsLastMinute, callsLastHour, budgetExhausted: status !== "ok" };
  }

  markRemoteRateLimited(provider: ProviderName, cooldownMs = 60_000): void {
    this.markRemoteProviderIssue(provider, { status: "rate_limited", errorCode: "rate_limited", cooldownMs });
  }

  isInRemoteRateLimitCooldown(provider: ProviderName): boolean {
    return this.getRemoteProviderIssue(provider)?.status === "rate_limited";
  }

  markRemoteProviderIssue(
    provider: ProviderName,
    params: { status: "rate_limited" | "budget_exhausted" | "auth_or_budget_issue"; errorCode: string; cooldownMs?: number },
  ): void {
    const now = this.now();
    this.remoteIssues.set(provider, {
      status: params.status,
      errorCode: params.errorCode,
      until: now + (params.cooldownMs ?? 60_000),
      at: now,
    });
  }

  getRemoteProviderIssue(provider: ProviderName): {
    status: "rate_limited" | "budget_exhausted" | "auth_or_budget_issue";
    errorCode: string;
    until: number;
    at: number;
  } | null {
    const now = this.now();
    this.prune(provider, now);
    return this.remoteIssues.get(provider) ?? null;
  }

  reset(): void {
    this.minuteHits.clear();
    this.hourHits.clear();
    this.remoteIssues.clear();
  }
}

// ---------------------------------------------------------------------------
// In-flight de-duplication
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<CachedCallResult<unknown>>>();

// ---------------------------------------------------------------------------
// Core orchestration function
// ---------------------------------------------------------------------------

export async function cachedProviderCall<T>(params: {
  key: string;
  provider: ProviderName;
  chainId: number;
  ttlSeconds: number;
  store: ProviderCacheStore;
  budget: ProviderBudget;
  fetcher: () => Promise<T>;
  shouldCache?: (data: T) => boolean;
}): Promise<CachedCallResult<T>> {
  const { key, provider, chainId, ttlSeconds, store, budget, fetcher, shouldCache } = params;
  const now = Date.now();

  // Reuse an in-flight call for the same key (de-duplication).
  const existing = inflight.get(key);
  if (existing) {
    const awaited = (await existing) as CachedCallResult<T>;
    return awaited;
  }

  const promise = (async (): Promise<CachedCallResult<T>> => {
    let entry: CacheEntry<T> | null;
    try {
      entry = await store.get<T>(key);
    } catch {
      entry = null; // store failure is non-fatal
    }

    const fresh = entry && entry.expiresAt > now;
    if (fresh && entry) {
      return {
        data: entry.payload,
        status: "cached",
        cacheAgeSeconds: Math.max(0, Math.round((now - entry.updatedAt) / 1000)),
        fromCache: true,
        providerCalled: false,
        budgetExhausted: false,
      };
    }

    const staleEntry = entry && entry.expiresAt <= now ? entry : null;

    // Budget guard: do not call the external provider when exhausted.
    if (!budget.canCall(provider)) {
      const remoteIssue = budget.getRemoteProviderIssue(provider);
      const blockedStatus: CacheStatus = remoteIssue?.status === "budget_exhausted" || remoteIssue?.status === "auth_or_budget_issue"
        ? "budget_exhausted"
        : remoteIssue?.status === "rate_limited"
          ? "rate_limited"
          : "failed";
      if (staleEntry) {
        return {
          data: staleEntry.payload,
          status: remoteIssue ? blockedStatus : "stale",
          cacheAgeSeconds: Math.max(0, Math.round((now - staleEntry.updatedAt) / 1000)),
          fromCache: true,
          providerCalled: false,
          budgetExhausted: true,
          errorCode: remoteIssue?.errorCode,
        };
      }
      return {
        data: undefined,
        status: blockedStatus,
        fromCache: false,
        providerCalled: false,
        budgetExhausted: true,
        error: remoteIssue ? "Provider remote budget/rate-limit cooldown active" : "Provider budget exhausted",
        errorCode: remoteIssue?.errorCode,
      };
    }

    budget.record(provider);
    try {
      const data = await fetcher();
      const liveEntry: CacheEntry<T> = {
        key,
        provider,
        chainId,
        payload: data,
        status: "live",
        createdAt: now,
        updatedAt: now,
        expiresAt: now + ttlSeconds * 1000,
      };
      if (!shouldCache || shouldCache(data)) {
        try {
          await store.set(liveEntry);
        } catch {
          // store write failure is non-fatal; result still returned
        }
      }
      return {
        data,
        status: "live",
        cacheAgeSeconds: 0,
        fromCache: false,
        providerCalled: true,
        budgetExhausted: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const budgetError = getProviderBudgetErrorDetails(err);
      if (budgetError) {
        budget.markRemoteProviderIssue(provider, {
          status: budgetError.status,
          errorCode: budgetError.errorCode,
        });
      }
      const errorStatus: CacheStatus = budgetError?.status === "budget_exhausted"
        ? "budget_exhausted"
        : budgetError?.status === "rate_limited"
          ? "rate_limited"
          : "failed";
      if (staleEntry) {
        // Keep the stale entry but record the recent failure on it (do not extend expiry).
        try {
          await store.set({ ...staleEntry, lastError: message, updatedAt: now });
        } catch {
          // non-fatal
        }
        return {
          data: staleEntry.payload,
          status: budgetError ? errorStatus : "stale",
          cacheAgeSeconds: Math.max(0, Math.round((now - staleEntry.updatedAt) / 1000)),
          fromCache: true,
          providerCalled: true,
          budgetExhausted: Boolean(budgetError),
          error: message,
          errorCode: budgetError?.errorCode,
        };
      }
      return {
        data: undefined,
        status: errorStatus,
        fromCache: false,
        providerCalled: true,
        budgetExhausted: Boolean(budgetError),
        error: message,
        errorCode: budgetError?.errorCode,
      };
    }
  })();

  inflight.set(key, promise as Promise<CachedCallResult<unknown>>);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Env configuration + singleton orchestrator
// ---------------------------------------------------------------------------

export interface ProviderCacheTtls {
  balances: number;
  prices: number;
  security: number;
  approvals: number;
}

export interface ProviderCacheOrchestrator {
  store: ProviderCacheStore;
  budget: ProviderBudget;
  ttls: ProviderCacheTtls;
  enabled: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

let orchestrator: ProviderCacheOrchestrator | null = null;

export function getProviderCacheOrchestratorFromEnv(): ProviderCacheOrchestrator {
  if (orchestrator) return orchestrator;
  const enabled = (process.env.PROVIDER_CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';
  const ttls: ProviderCacheTtls = {
    balances: envInt('PROVIDER_BALANCES_TTL_SECONDS', 1800),
    prices: envInt('PROVIDER_PRICES_TTL_SECONDS', 900),
    security: envInt('PROVIDER_SECURITY_TTL_SECONDS', 21600),
    approvals: envInt('PROVIDER_APPROVALS_TTL_SECONDS', 1800),
  };
  const maxPerMinute = envInt('PROVIDER_MAX_CALLS_PER_MINUTE', 20);
  const maxPerHour = envInt('PROVIDER_MAX_CALLS_PER_HOUR', 300);
  // Per-provider hourly budgets (per-minute stays the shared global default). Setting a per-provider
  // hour limit to 0 disables that provider via the budget guard while leaving the others running.
  const perProvider: Partial<Record<ProviderName, { maxPerMinute: number; maxPerHour: number }>> = {
    moralis: { maxPerMinute, maxPerHour: envInt('MORALIS_MAX_CALLS_PER_HOUR', maxPerHour) },
    goplus: { maxPerMinute, maxPerHour: envInt('GOPLUS_MAX_CALLS_PER_HOUR', maxPerHour) },
    coingecko: { maxPerMinute, maxPerHour: envInt('COINGECKO_MAX_CALLS_PER_HOUR', maxPerHour) },
    alchemy: { maxPerMinute, maxPerHour: envInt('ALCHEMY_MAX_CALLS_PER_HOUR', maxPerHour) },
  };
  const budget = new ProviderBudget(maxPerMinute, maxPerHour, perProvider);
  let store: ProviderCacheStore;
  if (enabled && process.env.DATABASE_URL) {
    store = new DbProviderCacheStore();
  } else {
    store = new NoopProviderCacheStore();
  }
  orchestrator = { store, budget, ttls, enabled };
  return orchestrator;
}

export function getProviderBudgetSnapshot(): Record<string, ProviderBudgetSnapshot> {
  const { budget } = getProviderCacheOrchestratorFromEnv();
  const providers: ProviderName[] = ['moralis', 'goplus', 'alchemy', 'coingecko'];
  const out: Record<string, ProviderBudgetSnapshot> = {};
  for (const p of providers) out[p] = budget.snapshot(p);
  return out;
}

export function getProviderCacheDiagnostics() {
  const orch = getProviderCacheOrchestratorFromEnv();
  return {
    enabled: orch.enabled,
    balancesTtlSeconds: orch.ttls.balances,
    pricesTtlSeconds: orch.ttls.prices,
    securityTtlSeconds: orch.ttls.security,
    approvalsTtlSeconds: orch.ttls.approvals,
  };
}

// Test helpers
export function setProviderCacheForTests(
  store: ProviderCacheStore,
  budget: ProviderBudget,
  ttls?: Partial<ProviderCacheTtls>,
): void {
  orchestrator = {
    store,
    budget,
    ttls: {
      balances: ttls?.balances ?? 1800,
      prices: ttls?.prices ?? 900,
      security: ttls?.security ?? 21600,
      approvals: ttls?.approvals ?? 1800,
    },
    enabled: true,
  };
}

export function clearProviderCacheForTests(): void {
  orchestrator = null;
  inflight.clear();
}
