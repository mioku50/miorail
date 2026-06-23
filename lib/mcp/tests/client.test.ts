import { describe, it } from "node:test";
import assert from "node:assert";
import { BaseMcpClient } from "../src/client.js";
import { MockMcpTransport } from "../src/mock_transport.js";

describe("BaseMcpClient", () => {
  it("should initialize without errors", async () => {
    const client = new BaseMcpClient();

    assert.ok(client);
  });

  it("should connect and close", async () => {
    const transport = new MockMcpTransport();
    const client = new BaseMcpClient();

    // Provide the initialization response via the transport immediately when send is called
    transport.send = async (message) => {
      if (message.method === "initialize") {
        setTimeout(() => {
          transport.receive({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2024-11-05", // from types
              capabilities: {},
              serverInfo: { name: "mock-server", version: "1.0.0" }
            }
          });
        }, 10);
      }
    };

    // Ensure we can connect
    await client.connect(transport);

    await client.close();
  });
});
