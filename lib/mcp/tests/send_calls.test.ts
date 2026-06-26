import { describe, it } from "node:test";
import assert from "node:assert";
import { McpSendCallsClient } from "../src/send_calls.js";
import { BaseMcpClient } from "../src/client.js";

describe("McpSendCallsClient security checks", () => {
  it("should block unsupported chains", async () => {
    const mockClient = { getClient: () => ({ callTool: async () => ({ content: [] }) }) } as unknown as BaseMcpClient;
    const client = new McpSendCallsClient(mockClient);
    await assert.rejects(client.sendCalls("1", [{ to: "0x123" }]), /Security check failed: Unsupported chain/);
  });

  it("should block non-canonical USDC", async () => {
    const mockClient = { getClient: () => ({ callTool: async () => ({ content: [] }) }) } as unknown as BaseMcpClient;
    const client = new McpSendCallsClient(mockClient);
    await assert.rejects(client.sendCalls("84532", [{ to: "0xdeadbeef", data: "0x095ea7b300" }]), /Security check failed: Invalid token address/);
    await assert.rejects(client.sendCalls("84532", [{ to: "0xdeadbeef", data: "0xa9059cbb00" }]), /Security check failed: Invalid token address/);
  });

  it("should allow canonical USDC", async () => {
    const mockClient = { getClient: () => ({ callTool: async () => ({ content: [{ type: 'text', text: '{"approvalUrl":"https://x.com", "requestId":"123"}' }] }) }) } as unknown as BaseMcpClient;
    const client = new McpSendCallsClient(mockClient);
    const res = await client.sendCalls("84532", [{ to: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", data: "0x095ea7b300" }]);
    assert.strictEqual(res.approvalUrl, "https://x.com");
  });
});
