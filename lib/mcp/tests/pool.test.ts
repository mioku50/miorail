import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BaseMcpClientPoolV1, baseMcpSessionForgottenV1, type BaseMcpPoolableClientV1 } from "../src/pool.js";

/** The shape the SDK's Streamable HTTP transport throws: HTTP status in `code`. */
class HttpLikeError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`Streamable HTTP error: ${message}`);
  }
}

/** The shape of a JSON-RPC error the server answered with. */
class AnsweredError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`MCP error ${code}: ${message}`);
    this.name = "McpError";
  }
}

type Behaviour = (connection: number, tool: string) => unknown;

function harness(options: {
  behaviour?: Behaviour;
  connect?: (connection: number) => Promise<void>;
  idleMs?: number;
  maxConnections?: number;
} = {}) {
  let clock = 0;
  const clients: FakeClient[] = [];
  const terminated: number[] = [];

  class FakeClient implements BaseMcpPoolableClientV1 {
    readonly id = clients.length + 1;
    connects = 0;
    closed = false;
    constructor() {
      clients.push(this);
    }
    async connect(): Promise<void> {
      this.connects += 1;
      await options.connect?.(this.id);
    }
    async close(): Promise<void> {
      this.closed = true;
    }
    getClient() {
      const id = this.id;
      return {
        callTool: (async (params: { name: string }) => {
          const result = options.behaviour?.(id, params.name);
          if (result instanceof Error) throw result;
          return result ?? { content: [{ type: "text", text: `connection ${id}` }] };
        }) as never,
        listTools: (async () => ({ tools: [{ name: "get_wallets", inputSchema: { type: "object" } }] })) as never,
      };
    }
  }

  let transports = 0;
  const pool = new BaseMcpClientPoolV1({
    idleMs: options.idleMs ?? 1_000,
    maxConnections: options.maxConnections,
    now: () => clock,
    createClient: () => new FakeClient(),
  });
  const input = (userId = "user-1", generation = "g1") => ({
    userId,
    generation,
    serverUrl: new URL("https://wallet-mcp.example"),
    createTransport: () => {
      const n = ++transports;
      return { terminateSession: async () => { terminated.push(n); } } as unknown as Transport;
    },
  });
  // Closing runs on the next turn of the event loop.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    pool,
    clients,
    terminated,
    input,
    settle,
    advance: (ms: number) => { clock += ms; },
  };
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

describe("Wallet MCP connection pool", () => {
  it("shares one connection between a person's requests and keeps it open after them", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.pool.lease(h.input()), h.pool.lease(h.input())]);
    assert.equal(text(await a.getClient().callTool({ name: "get_wallets" })), "connection 1");
    assert.equal(text(await b.getClient().callTool({ name: "get_wallets" })), "connection 1");
    await a.close();
    await b.close();
    await h.settle();

    const c = await h.pool.lease(h.input());
    assert.equal(text(await c.getClient().callTool({ name: "get_wallets" })), "connection 1");
    await c.close();
    assert.equal(h.clients.length, 1);
    assert.equal(h.clients[0]!.connects, 1, "one initialize for three requests");
    assert.equal(h.clients[0]!.closed, false);
    assert.equal(h.pool.size, 1);
  });

  it("gives different people different connections", async () => {
    const h = harness();
    const a = await h.pool.lease(h.input("user-1"));
    const b = await h.pool.lease(h.input("user-2"));
    assert.equal(text(await a.getClient().callTool({ name: "x" })), "connection 1");
    assert.equal(text(await b.getClient().callTool({ name: "x" })), "connection 2");
    await a.close();
    await b.close();
    assert.equal(h.pool.size, 2);
  });

  it("retires a connection from an older grant once its request is done", async () => {
    const h = harness();
    const old = await h.pool.lease(h.input("user-1", "connected-at-1"));
    const fresh = await h.pool.lease(h.input("user-1", "connected-at-2"));
    assert.equal(text(await fresh.getClient().callTool({ name: "x" })), "connection 2");
    await h.settle();
    assert.equal(h.clients[0]!.closed, false, "the request still running on it finishes");
    assert.equal(text(await old.getClient().callTool({ name: "x" })), "connection 1");
    await old.close();
    await h.settle();
    assert.equal(h.clients[0]!.closed, true);
    assert.deepEqual(h.terminated, [1], "the superseded session is ended politely");
    await fresh.close();
    assert.equal(h.pool.size, 1);
  });

  it("retries a forgotten session once, on a fresh connection", async () => {
    const h = harness({
      behaviour: (connection) => (connection === 1 ? new HttpLikeError(404, "Session not found") : undefined),
    });
    const lease = await h.pool.lease(h.input());
    assert.equal(text(await lease.getClient().callTool({ name: "send_calls" })), "connection 2");
    await h.settle();
    assert.equal(h.clients[0]!.closed, true);
    assert.deepEqual(h.terminated, [], "a forgotten session is not ended again");
    await lease.close();
    await h.settle();
    assert.equal(h.clients[1]!.closed, false, "the fresh connection is kept for the next request");
    assert.equal(h.pool.size, 1);
  });

  it("does not retry a second time", async () => {
    const h = harness({ behaviour: () => new HttpLikeError(404, "Session not found") });
    const lease = await h.pool.lease(h.input());
    await assert.rejects(lease.getClient().callTool({ name: "x" }), (error) => baseMcpSessionForgottenV1(error));
    assert.equal(h.clients.length, 2, "one retry, not a loop");
    await lease.close();
  });

  it("calls that met the forgotten session together share one replacement", async () => {
    const h = harness({
      behaviour: (connection) => (connection === 1 ? new HttpLikeError(404, "Session not found") : undefined),
    });
    const lease = await h.pool.lease(h.input());
    const results = await Promise.all([
      lease.getClient().callTool({ name: "a" }),
      lease.getClient().callTool({ name: "b" }),
    ]);
    assert.deepEqual(results.map(text), ["connection 2", "connection 2"]);
    assert.equal(h.clients.length, 2);
    await lease.close();
    // Nothing still counts as using it: it idles out like any other.
    h.advance(1_000);
    h.pool.sweep();
    await h.settle();
    assert.equal(h.clients[1]!.closed, true);
    assert.equal(h.pool.size, 0);
  });

  it("keeps the connection when the server answered with an error", async () => {
    const h = harness({
      behaviour: (connection, tool) => (tool === "bad" ? new AnsweredError(-32602, "Invalid params") : undefined),
    });
    const lease = await h.pool.lease(h.input());
    await assert.rejects(lease.getClient().callTool({ name: "bad" }), /Invalid params/);
    assert.equal(text(await lease.getClient().callTool({ name: "good" })), "connection 1");
    await lease.close();
    assert.equal(h.clients.length, 1);
  });

  it("drops the connection without a retry when the request may have run", async () => {
    let failures = 0;
    const h = harness({
      behaviour: (connection) => {
        if (connection === 1) {
          failures += 1;
          return new TypeError("fetch failed");
        }
        return undefined;
      },
    });
    const lease = await h.pool.lease(h.input());
    await assert.rejects(lease.getClient().callTool({ name: "send_calls" }), /fetch failed/);
    assert.equal(failures, 1, "a write is never sent twice");
    await lease.close();
    await h.settle();
    assert.equal(h.clients[0]!.closed, true);

    const next = await h.pool.lease(h.input());
    assert.equal(text(await next.getClient().callTool({ name: "x" })), "connection 2");
    await next.close();
  });

  it("treats a closed connection and a timed-out request as connection failures", async () => {
    const h = harness({
      behaviour: (connection) => (connection === 1 ? new AnsweredError(-32001, "Request timed out") : undefined),
    });
    const lease = await h.pool.lease(h.input());
    await assert.rejects(lease.getClient().callTool({ name: "x" }), /timed out/);
    await lease.close();
    const next = await h.pool.lease(h.input());
    assert.equal(text(await next.getClient().callTool({ name: "x" })), "connection 2");
    await next.close();
  });

  it("closes an idle connection after idleMs and ends its session", async () => {
    const h = harness({ idleMs: 1_000 });
    const lease = await h.pool.lease(h.input());
    await lease.close();
    h.advance(999);
    h.pool.sweep();
    await h.settle();
    assert.equal(h.clients[0]!.closed, false);
    h.advance(1);
    h.pool.sweep();
    await h.settle();
    assert.equal(h.clients[0]!.closed, true);
    assert.deepEqual(h.terminated, [1]);
    assert.equal(h.pool.size, 0);
  });

  it("never closes a connection a request still holds", async () => {
    const h = harness({ idleMs: 1_000 });
    const lease = await h.pool.lease(h.input());
    h.advance(5_000);
    h.pool.sweep();
    await h.settle();
    assert.equal(h.clients[0]!.closed, false);
    await lease.close();
  });

  it("does not keep a connection that failed to open", async () => {
    const h = harness({
      connect: async (connection) => {
        if (connection === 1) throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(h.pool.lease(h.input()), /fetch failed/);
    assert.equal(h.pool.size, 0);
    const lease = await h.pool.lease(h.input());
    assert.equal(text(await lease.getClient().callTool({ name: "x" })), "connection 2");
    await lease.close();
  });

  it("leaves a slow connection opening for the next request when one caller stops waiting", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    const h = harness({ connect: () => opened });
    await assert.rejects(h.pool.lease({ ...h.input(), connectTimeoutMs: 5 }), /timeout/);
    open();
    const lease = await h.pool.lease(h.input());
    assert.equal(text(await lease.getClient().callTool({ name: "x" })), "connection 1");
    assert.equal(h.clients.length, 1);
    await lease.close();
  });

  it("closes one person's connections on disconnect and nobody else's", async () => {
    const h = harness();
    await (await h.pool.lease(h.input("user-1"))).close();
    await (await h.pool.lease(h.input("user-2"))).close();
    h.pool.evictUser("user-1");
    await h.settle();
    assert.equal(h.clients[0]!.closed, true);
    assert.equal(h.clients[1]!.closed, false);
    assert.equal(h.pool.size, 1);
  });

  it("past the cap, closes the least recently used idle connection first", async () => {
    const h = harness({ maxConnections: 2 });
    await (await h.pool.lease(h.input("user-1"))).close();
    h.advance(10);
    await (await h.pool.lease(h.input("user-2"))).close();
    h.advance(10);
    await (await h.pool.lease(h.input("user-3"))).close();
    await h.settle();
    assert.deepEqual(h.clients.map((client) => client.closed), [true, false, false]);
    assert.equal(h.pool.size, 2);
  });

  it("refuses a call on a lease that was given back", async () => {
    const h = harness();
    const lease = await h.pool.lease(h.input());
    await lease.close();
    await assert.rejects(lease.getClient().callTool({ name: "x" }), /already returned/);
  });

  it("recognises the transport's forgotten-session error and nothing else", () => {
    assert.equal(baseMcpSessionForgottenV1(new HttpLikeError(404, "Session not found")), true);
    assert.equal(baseMcpSessionForgottenV1(new HttpLikeError(500, "boom")), false);
    assert.equal(baseMcpSessionForgottenV1(new AnsweredError(404, "not a transport error")), false);
    assert.equal(baseMcpSessionForgottenV1(new TypeError("fetch failed")), false);
  });
});
