import { ToolDef, ToolProvider } from './provider.js';

export class ToolAggregator {
  private providers: Map<string, ToolProvider> = new Map();

  registerProvider(provider: ToolProvider): void {
    this.providers.set(provider.id, provider);
  }

  async listTools(): Promise<ToolDef[]> {
    const allTools: ToolDef[] = [];
    for (const provider of this.providers.values()) {
      const tools = await provider.listTools();
      allTools.push(...tools);
    }
    return allTools;
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
