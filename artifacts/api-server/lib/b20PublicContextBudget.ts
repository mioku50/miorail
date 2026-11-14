import { InMemoryRateLimiter } from '@mioagent/utils';

const UTC_DAY_MS = 86_400_000;

export class B20PublicContextBudgetError extends Error {
  constructor(readonly reason: 'client_limit' | 'client_daily_limit' | 'daily_limit') {
    super(reason === 'daily_limit'
      ? "This server's daily budget for public lookups is spent. That is not a statement about the token."
      : reason === 'client_daily_limit'
        ? "This client has used its share of today's public lookups. That is not a statement about the token."
        : 'This client has reached the public-lookup limit of six requests per minute. That is not a statement about the token.');
    this.name = 'B20PublicContextBudgetError';
  }
}

// ---------------------------------------------------------------------------
// One client's share of the day (audit MCP-4, 2026-11-14).
//
// The day's 200 paid searches were one pool for the whole process, and the
// only bound on a client was six lookups a minute. A lookup that finds nothing
// widens to the symbol, so one anonymous address asking six times a minute
// spent the pool in 17 to 34 minutes, and until the UTC day turned every
// client, connected grants included, was told the budget was spent.
//
// Now each client may reserve ten searches a day, and clients that are not a
// connected grant share 150 of the 200 between them, so the last 50 are kept
// for grants whoever else asks. A search reserved without naming its client
// draws on the day's pool alone, as before.
// ---------------------------------------------------------------------------

/** Paid searches one client may reserve in a UTC day. */
export const B20_PUBLIC_CONTEXT_CLIENT_DAILY_SEARCHES_V1 = 10;
/** Of the day's searches, how many clients that are not a connected grant share between them. */
export const B20_PUBLIC_CONTEXT_PUBLIC_DAILY_SEARCHES_V1 = 150;
/** The key prefix the private MCP server gives a connected grant. */
const CONNECTED_CLIENT_PREFIX_V1 = 'private:';

export class B20PublicContextBudgetV1 {
  private readonly clients: InMemoryRateLimiter;
  private readonly dailySearchMax: number;
  private readonly clientDailySearchMax: number;
  private readonly publicDailySearchMax: number;
  private readonly now: () => number;
  private day: number;
  private searches = 0;
  private publicSearches = 0;
  private readonly byClient = new Map<string, number>();

  constructor(options: { dailySearchMax?: number; clientDailySearchMax?: number; publicDailySearchMax?: number; now?: () => number } = {}) {
    this.clients = new InMemoryRateLimiter({ windowMs: 60_000, max: 6 });
    this.dailySearchMax = options.dailySearchMax ?? 200;
    this.clientDailySearchMax = options.clientDailySearchMax ?? B20_PUBLIC_CONTEXT_CLIENT_DAILY_SEARCHES_V1;
    this.publicDailySearchMax = options.publicDailySearchMax ?? Math.min(B20_PUBLIC_CONTEXT_PUBLIC_DAILY_SEARCHES_V1, this.dailySearchMax);
    for (const value of [this.dailySearchMax, this.clientDailySearchMax, this.publicDailySearchMax]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('search maxima must be positive safe integers');
    }
    this.now = options.now ?? Date.now;
    this.day = Math.floor(this.now() / UTC_DAY_MS);
  }

  async consumeLookup(clientKey: string): Promise<void> {
    if (!(await this.clients.consume(clientKey)).success) {
      throw new B20PublicContextBudgetError('client_limit');
    }
  }

  /** Reserve each actual upstream attempt synchronously, before it can await. A failed search still costs a
   * request. Clock rollback never grants a new day. With a client key, that client's daily share and, for a
   * client that is not a connected grant, the public share are reserved as well. */
  reserveSearch(clientKey?: string): void {
    const day = Math.floor(this.now() / UTC_DAY_MS);
    if (day > this.day) {
      this.day = day;
      this.searches = 0;
      this.publicSearches = 0;
      this.byClient.clear();
    }
    if (this.searches >= this.dailySearchMax) throw new B20PublicContextBudgetError('daily_limit');
    if (clientKey !== undefined) {
      const connected = clientKey.startsWith(CONNECTED_CLIENT_PREFIX_V1);
      if (!connected && this.publicSearches >= this.publicDailySearchMax) throw new B20PublicContextBudgetError('daily_limit');
      const used = this.byClient.get(clientKey) ?? 0;
      if (used >= this.clientDailySearchMax) throw new B20PublicContextBudgetError('client_daily_limit');
      // At most one entry per search of the day, so the map is bounded by the day's pool.
      this.byClient.set(clientKey, used + 1);
      if (!connected) this.publicSearches++;
    }
    this.searches++;
  }
}

/** MCP servers are created per HTTP request; their paid budget must not be. */
export const b20McpPublicContextBudgetV1 = new B20PublicContextBudgetV1();

/** Server-owned context, never accepted as MCP tool arguments or returned. */
export interface B20McpPublicContextRequestV1 {
  clientKey: string;
  budget?: B20PublicContextBudgetV1;
}
