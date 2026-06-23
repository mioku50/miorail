import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class BaseMcpClient {
  private client: Client;

  constructor() {
    this.client = new Client({
      name: "mioagent",
      version: "1.0.0",
    }, {
      capabilities: {}
    });
  }

  async connect(transport: Transport) {
    await this.client.connect(transport);
  }

  async close() {
    await this.client.close();
  }

  getClient() {
    return this.client;
  }
}
