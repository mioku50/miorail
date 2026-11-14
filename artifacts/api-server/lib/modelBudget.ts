import { InMemoryRateLimiter, rateLimitAddressKeyV1 } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// One budget of model calls for the server (audit MCP-5, 2026-11-14).
//
// Chat and the Agent were limited per wallet, twelve questions a minute each,
// and a wallet costs nothing: one address could sign in with fresh keys and
// ask from nine wallets at the API's ceiling of 100 requests a minute. A chat
// question is up to nine model calls with the whole tool list in the prompt,
// and the lane behind them is metered by tokens a minute, so one address could
// hold the shared lane and everybody else's chat answered with an error.
//
// Now every model call of chat, its routing and the Agent takes a place first:
// at most 20 a minute from one address, 60 a minute and 5,000 a UTC day for
// the whole server. A call refused here never reaches a provider: chat says
// the model is busy, and the Agent answers with its fixed rules alone.
// ---------------------------------------------------------------------------

export const MODEL_CALLS_PER_CLIENT_PER_MINUTE_V1 = 20;
export const MODEL_CALLS_PER_MINUTE_V1 = 60;
export const MODEL_CALLS_PER_DAY_V1 = 5_000;
const UTC_DAY_MS_V1 = 86_400_000;

export class ModelBudgetSpentErrorV1 extends Error {
  constructor(readonly scope: 'client' | 'minute' | 'day') {
    super(scope === 'client'
      ? 'This address has asked the model as often as one address may in a minute. Ask again in a minute.'
      : scope === 'minute'
        ? 'The model is busy for everyone just now: Miorail keeps one budget of model calls for all its users. Ask again in a minute.'
        : 'Today’s budget of model calls for this server is spent. It returns at 00:00 UTC.');
    this.name = 'ModelBudgetSpentErrorV1';
  }
}

export class ModelBudgetV1 {
  private readonly clients: InMemoryRateLimiter;
  private readonly server: InMemoryRateLimiter;
  private readonly perDay: number;
  private readonly now: () => number;
  private day: number;
  private today = 0;

  constructor(options: { perClientPerMinute?: number; perMinute?: number; perDay?: number; now?: () => number } = {}) {
    this.clients = new InMemoryRateLimiter({ windowMs: 60_000, max: options.perClientPerMinute ?? MODEL_CALLS_PER_CLIENT_PER_MINUTE_V1 });
    this.server = new InMemoryRateLimiter({ windowMs: 60_000, max: options.perMinute ?? MODEL_CALLS_PER_MINUTE_V1 });
    this.perDay = options.perDay ?? MODEL_CALLS_PER_DAY_V1;
    this.now = options.now ?? Date.now;
    this.day = Math.floor(this.now() / UTC_DAY_MS_V1);
  }

  /** One model call's place, taken before the call: the address's minute, the server's minute, the day.
   * Throws ModelBudgetSpentErrorV1 when any is spent. A clock moved back never grants a new day. */
  async take(clientKey: string): Promise<void> {
    const day = Math.floor(this.now() / UTC_DAY_MS_V1);
    if (day > this.day) { this.day = day; this.today = 0; }
    if (this.today >= this.perDay) throw new ModelBudgetSpentErrorV1('day');
    if (!(await this.clients.consume(clientKey)).success) throw new ModelBudgetSpentErrorV1('client');
    if (!(await this.server.consume('model')).success) throw new ModelBudgetSpentErrorV1('minute');
    this.today++;
  }
}

/** The process's one budget; swappable, so a test does not depend on what the tests before it spent. */
export const modelBudgetRuntimeV1 = { budget: new ModelBudgetV1() };

/** The address a request's model calls are counted under: an IPv6 client by its /64, as every address
 * limiter counts it (audit AUTH-3), so one host cannot spend the budget again from each of its addresses. */
export function modelBudgetClientKeyV1(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return `ip:${rateLimitAddressKeyV1(req.ip || req.socket?.remoteAddress || 'unknown')}`;
}
