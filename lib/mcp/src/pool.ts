import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BaseMcpClient } from "./client.js";

// ---------------------------------------------------------------------------
// One Wallet MCP connection per person, kept between requests.
//
// Every console question, tool probe and wallet check used to open its own
// connection — an initialize round trip, the initialized notification and a
// stream attempt before the first real call — and close it after. This keeps
// the person's connection open and shares it, the way a desktop client holds
// one.
//
// A kept connection can be forgotten: the server may drop an idle session, and
// says so with a 404 to a request that carries the session id. The server did
// NOT run that request, so it is the one failure retried, once, on a fresh
// connection. Any other failure that could have come from the connection
// drops it without a retry, because a write may have landed; the next request
// opens a new one. An error the server answered with (a JSON-RPC error) is an
// answer, and the connection stays.
//
// The pool holds no credential. A transport reads the person's tokens from
// the store on every request, so a refresh or a revocation reaches a kept
// connection on its next call. A reconnect changes the generation, which
// retires the old connection outright: a new grant may be another wallet.
// ---------------------------------------------------------------------------

type ToolCallParams = Parameters<Client["callTool"]>[0];
type ToolListParams = Parameters<Client["listTools"]>[0];

/** The two calls Miorail makes on a Wallet MCP connection. */
export interface BaseMcpCallsV1 {
  callTool(params: ToolCallParams): ReturnType<Client["callTool"]>;
  listTools(params?: ToolListParams): ReturnType<Client["listTools"]>;
}

/** What the pool keeps open. `BaseMcpClient` is one. */
export interface BaseMcpPoolableClientV1 {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  getClient(): BaseMcpCallsV1;
}

export interface BaseMcpLeaseInputV1 {
  /** Whose connection. One per person and server. */
  userId: string;
  serverUrl: URL;
  /** Changes when the grant does; a new generation retires the kept connection. */
  generation: string;
  createTransport: () => Transport;
  /** The client to open if this person has no connection yet; the pool's own by default. */
  createClient?: () => BaseMcpPoolableClientV1;
  /** How long this caller waits for a connection that is still opening. */
  connectTimeoutMs?: number;
}

/** A borrowed connection. `close()` gives it back; it stays open for the next request. */
export interface BaseMcpClientLeaseV1 {
  getClient(): BaseMcpCallsV1;
  close(): Promise<void>;
}

export interface BaseMcpClientPoolOptionsV1 {
  /** A connection nobody has used for this long is closed. */
  idleMs?: number;
  /** Past this many, the least recently used idle connection is closed first. */
  maxConnections?: number;
  /** A connection still opening after this long is dropped, whoever waits. */
  connectDeadlineMs?: number;
  now?: () => number;
  createClient?: () => BaseMcpPoolableClientV1;
}

interface PoolEntryV1 {
  key: string;
  userId: string;
  generation: string;
  client: BaseMcpPoolableClientV1;
  transport: Transport;
  ready: Promise<void>;
  leases: number;
  lastUsedAt: number;
  retired: boolean;
  /** End the server's session on close: an idle or superseded connection. */
  terminate: boolean;
  closed: boolean;
}

export const BASE_MCP_CONNECTION_IDLE_MS_V1 = 10 * 60 * 1000;
const MAX_CONNECTIONS_V1 = 200;
const CONNECT_DEADLINE_MS_V1 = 20_000;
const TERMINATE_TIMEOUT_MS_V1 = 3_000;

/** HTTP 404 to a request that carried a session id: the server forgot the session. */
export function baseMcpSessionForgottenV1(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined;
  return e?.code === 404 && typeof e.message === "string" && e.message.startsWith("Streamable HTTP error:");
}

/** A JSON-RPC error the server answered with. The connection carried it fine. */
function serverAnsweredV1(error: unknown): boolean {
  const e = error as { name?: unknown; code?: unknown } | null | undefined;
  return e?.name === "McpError"
    && typeof e.code === "number"
    // The SDK reports a closed connection and a request it stopped waiting
    // for as McpErrors too, and neither is an answer.
    && e.code !== -32000
    && e.code !== -32001;
}

async function withTimeoutV1<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("timeout");
      error.name = "AbortError";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BaseMcpClientPoolV1 {
  private readonly entries = new Map<string, PoolEntryV1>();
  private readonly idleMs: number;
  private readonly maxConnections: number;
  private readonly connectDeadlineMs: number;
  private readonly now: () => number;
  private readonly createClient: () => BaseMcpPoolableClientV1;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: BaseMcpClientPoolOptionsV1 = {}) {
    this.idleMs = options.idleMs ?? BASE_MCP_CONNECTION_IDLE_MS_V1;
    this.maxConnections = options.maxConnections ?? MAX_CONNECTIONS_V1;
    this.connectDeadlineMs = options.connectDeadlineMs ?? CONNECT_DEADLINE_MS_V1;
    this.now = options.now ?? Date.now;
    this.createClient = options.createClient ?? (() => new BaseMcpClient());
  }

  /** Open connections, for status and tests. */
  get size(): number {
    return this.entries.size;
  }

  async lease(input: BaseMcpLeaseInputV1): Promise<BaseMcpClientLeaseV1> {
    const entry = await this.acquire(input);
    return new PooledLeaseV1(this, entry, input);
  }

  /** Close a person's connections now: on disconnect, or when a grant is revoked. */
  evictUser(userId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.userId === userId) this.retire(entry);
    }
  }

  /** Close every idle connection past `idleMs`. Runs on a timer; tests call it. */
  sweep(): void {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.leases === 0 && now - entry.lastUsedAt >= this.idleMs) this.retire(entry, { terminate: true });
    }
    if (this.entries.size === 0) this.stopSweeper();
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) this.retire(entry, { terminate: true });
    this.stopSweeper();
  }

  /** @internal A counted claim on the person's connection, opened if needed. */
  async acquire(input: BaseMcpLeaseInputV1): Promise<PoolEntryV1> {
    const entry = this.usableEntry(input);
    entry.leases += 1;
    try {
      await withTimeoutV1(entry.ready, input.connectTimeoutMs);
    } catch (error) {
      // This caller stops waiting. The connection, if it opens, is still the
      // person's for the next request; a failed open has retired itself.
      this.release(entry);
      throw error;
    }
    entry.lastUsedAt = this.now();
    return entry;
  }

  /** @internal */
  release(entry: PoolEntryV1): void {
    entry.leases = Math.max(0, entry.leases - 1);
    entry.lastUsedAt = this.now();
    if (entry.retired && entry.leases === 0) this.shut(entry);
  }

  /** @internal Out of the pool; closed once its last lease is given back. */
  retire(entry: PoolEntryV1, options: { terminate?: boolean } = {}): void {
    entry.retired = true;
    entry.terminate = entry.terminate || options.terminate === true;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.leases === 0) this.shut(entry);
  }

  private usableEntry(input: BaseMcpLeaseInputV1): PoolEntryV1 {
    const key = `${input.userId}\u0000${input.serverUrl.host.toLowerCase()}`;
    const existing = this.entries.get(key);
    if (existing && !existing.retired && existing.generation === input.generation) return existing;
    if (existing) this.retire(existing, { terminate: true });
    this.makeRoom();
    const entry = this.open(key, input);
    this.entries.set(key, entry);
    this.startSweeper();
    return entry;
  }

  private open(key: string, input: BaseMcpLeaseInputV1): PoolEntryV1 {
    const client = (input.createClient ?? this.createClient)();
    const transport = input.createTransport();
    const entry: PoolEntryV1 = {
      key,
      userId: input.userId,
      generation: input.generation,
      client,
      transport,
      ready: Promise.resolve(),
      leases: 0,
      lastUsedAt: this.now(),
      retired: false,
      terminate: false,
      closed: false,
    };
    entry.ready = withTimeoutV1(client.connect(transport), this.connectDeadlineMs).catch((error: unknown) => {
      this.retire(entry);
      throw error;
    });
    // Whoever waits sees the failure; nobody waiting must not make it unhandled.
    entry.ready.catch(() => undefined);
    return entry;
  }

  private makeRoom(): void {
    if (this.entries.size < this.maxConnections) return;
    let oldest: PoolEntryV1 | null = null;
    for (const entry of this.entries.values()) {
      if (entry.leases === 0 && (!oldest || entry.lastUsedAt < oldest.lastUsedAt)) oldest = entry;
    }
    // Every connection busy: go over the cap rather than fail a request.
    if (oldest) this.retire(oldest, { terminate: true });
  }

  private shut(entry: PoolEntryV1): void {
    if (entry.closed) return;
    entry.closed = true;
    void (async () => {
      // A session the server still holds is ended politely, as the transport
      // spec asks. A connection dropped for a failure is not: its session is
      // likely gone already.
      const end = (entry.transport as { terminateSession?: () => Promise<void> }).terminateSession;
      if (entry.terminate && typeof end === "function") {
        await withTimeoutV1(end.call(entry.transport), TERMINATE_TIMEOUT_MS_V1).catch(() => undefined);
      }
      await entry.client.close().catch(() => undefined);
    })();
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1_000, Math.min(60_000, Math.floor(this.idleMs / 2))));
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }
}

class PooledLeaseV1 implements BaseMcpClientLeaseV1 {
  private released = false;
  /** One replacement at a time: calls that failed together share it. */
  private replacing: { from: PoolEntryV1; to: Promise<PoolEntryV1> } | null = null;

  constructor(
    private readonly pool: BaseMcpClientPoolV1,
    private entry: PoolEntryV1,
    private readonly input: BaseMcpLeaseInputV1,
  ) {}

  getClient(): BaseMcpCallsV1 {
    return {
      callTool: (params) => this.run((client) => client.callTool(params)),
      listTools: (params) => this.run((client) => client.listTools(params)),
    };
  }

  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    // A replacement still opening decides which connection this lease holds.
    if (this.replacing) await this.replacing.to.catch(() => undefined);
    this.pool.release(this.entry);
  }

  private async run<T>(call: (client: BaseMcpCallsV1) => Promise<T>): Promise<T> {
    if (this.released) throw new Error("Wallet MCP lease was already returned");
    const entry = this.entry;
    try {
      return await call(entry.client.getClient());
    } catch (error) {
      if (serverAnsweredV1(error)) throw error;
      this.pool.retire(entry);
      if (!baseMcpSessionForgottenV1(error)) throw error;
      // The server forgot the session and ran nothing: the one retry, on a
      // fresh connection that this lease now holds instead.
      const fresh = await this.replace(entry);
      return call(fresh.client.getClient());
    }
  }

  private async replace(entry: PoolEntryV1): Promise<PoolEntryV1> {
    // Another call on this lease already moved it to a fresh connection.
    if (this.entry !== entry) return this.entry;
    if (this.replacing?.from === entry) return this.replacing.to;
    const to = this.pool.acquire(this.input).then((fresh) => {
      this.pool.release(entry);
      this.entry = fresh;
      return fresh;
    });
    this.replacing = { from: entry, to };
    try {
      return await to;
    } finally {
      if (this.replacing?.to === to) this.replacing = null;
    }
  }
}

let sharedPoolV1: BaseMcpClientPoolV1 | null = null;

/** The process's pool. `BASE_MCP_CONNECTION_IDLE_MS` sets how long an unused connection stays open. */
export function baseMcpClientPoolV1(): BaseMcpClientPoolV1 {
  if (!sharedPoolV1) {
    const parsed = Number(process.env.BASE_MCP_CONNECTION_IDLE_MS);
    const idleMs = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60 * 60 * 1000) : BASE_MCP_CONNECTION_IDLE_MS_V1;
    sharedPoolV1 = new BaseMcpClientPoolV1({ idleMs });
  }
  return sharedPoolV1;
}
