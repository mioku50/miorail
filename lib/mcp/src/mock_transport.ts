import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class MockMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private connected = false;

  async start(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.onclose) {
      this.onclose();
    }
  }

  async send(_message: JSONRPCMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("Transport is not connected");
    }
    // Simple echo/mock logic could go here
    // For now, it just swallows messages in mock
  }

  // Expose this so tests can push messages
  receive(message: JSONRPCMessage) {
    if (this.onmessage && this.connected) {
      this.onmessage(message);
    }
  }
}
