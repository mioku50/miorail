import { InMemoryRateLimiter } from '@mioagent/utils';

const UTC_DAY_MS = 86_400_000;

export class B20PublicContextBudgetError extends Error {
  constructor(readonly reason: 'client_limit' | 'daily_limit') {
    super(reason === 'daily_limit'
      ? "This server's daily budget for public lookups is spent. That is not a statement about the token."
      : 'This client has reached the public-lookup limit of six requests per minute. That is not a statement about the token.');
    this.name = 'B20PublicContextBudgetError';
  }
}

export class B20PublicContextBudgetV1 {
  private readonly clients: InMemoryRateLimiter;
  private readonly dailySearchMax: number;
  private readonly now: () => number;
  private day: number;
  private searches = 0;

  constructor(options: { dailySearchMax?: number; now?: () => number } = {}) {
    this.clients = new InMemoryRateLimiter({ windowMs: 60_000, max: 6 });
    this.dailySearchMax = options.dailySearchMax ?? 200;
    if (!Number.isSafeInteger(this.dailySearchMax) || this.dailySearchMax < 1) {
      throw new RangeError('dailySearchMax must be a positive safe integer');
    }
    this.now = options.now ?? Date.now;
    this.day = Math.floor(this.now() / UTC_DAY_MS);
  }

  async consumeLookup(clientKey: string): Promise<void> {
    if (!(await this.clients.consume(clientKey)).success) {
      throw new B20PublicContextBudgetError('client_limit');
    }
  }

  /** Reserve each actual upstream attempt synchronously, before it can await.
   * A failed search still costs a request. Clock rollback never grants a new day. */
  reserveSearch(): void {
    const day = Math.floor(this.now() / UTC_DAY_MS);
    if (day > this.day) {
      this.day = day;
      this.searches = 0;
    }
    if (this.searches >= this.dailySearchMax) throw new B20PublicContextBudgetError('daily_limit');
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
