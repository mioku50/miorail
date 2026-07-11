import { ToolDef, ToolProvider } from './provider.js';

export class ToolAggregator {
  private providers: Map<string, ToolProvider> = new Map();
  private cleanups: Array<() => void | Promise<void>> = [];

  registerProvider(provider: ToolProvider): void {
    this.providers.set(provider.id, provider);
  }

  registerCleanup(cleanup: () => void | Promise<void>): void {
    this.cleanups.push(cleanup);
  }

  async close(): Promise<void> {
    const cleanups = this.cleanups.splice(0).reverse();
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  }

  async listTools(): Promise<ToolDef[]> {
    const allTools: ToolDef[] = [];
    for (const provider of this.providers.values()) {
      const tools = await provider.listTools();
      allTools.push(...tools);
    }
    return allTools;
  }

  async listProviderTools(): Promise<Array<{ providerId: string; tools: ToolDef[] }>> {
    const inventory: Array<{ providerId: string; tools: ToolDef[] }> = [];
    for (const provider of this.providers.values()) {
      inventory.push({ providerId: provider.id, tools: await provider.listTools() });
    }
    return inventory;
  }

  findTool(name: string): ToolDef | undefined {
    for (const provider of this.providers.values()) {
      const tool = provider.findTool(name);
      if (tool) return tool;
    }
    return undefined;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    for (const provider of this.providers.values()) {
      const tool = provider.findTool(name);
      if (tool) {
        return provider.callTool(name, args);
      }
    }
    throw new Error(`Tool '${name}' not found`);
  }
}
