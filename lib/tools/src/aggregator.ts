import { ToolDef, ToolProvider, type ToolCallContextV1 } from './provider.js';
import { abortableV1 } from '@mioagent/utils';

export class ToolAggregator {
  private providers: Map<string, ToolProvider> = new Map();
  private cleanups: Array<() => void | Promise<void>> = [];
  private signal?: AbortSignal;

  /** One request owns this aggregator; direct and agent reads share its cancellation. */
  setAbortSignal(signal: AbortSignal): void { this.signal = signal; }

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
      const tools = await abortableV1(this.signal, () => provider.listTools());
      allTools.push(...tools);
    }
    return allTools;
  }

  async listProviderTools(): Promise<Array<{ providerId: string; tools: ToolDef[] }>> {
    const inventory: Array<{ providerId: string; tools: ToolDef[] }> = [];
    for (const provider of this.providers.values()) {
      inventory.push({ providerId: provider.id, tools: await abortableV1(this.signal, () => provider.listTools()) });
    }
    return inventory;
  }

  /** Disable OAuth-wallet capabilities while leaving protocol/data reads available. */
  setBaseMcpWalletToolsEnabled(enabled: boolean): void {
    for (const provider of this.providers.values()) {
      const scoped = provider as ToolProvider & { setWalletToolsEnabled?: (value: boolean) => void };
      scoped.setWalletToolsEnabled?.(enabled);
    }
  }

  findTool(name: string): ToolDef | undefined {
    for (const provider of this.providers.values()) {
      const tool = provider.findTool(name);
      if (tool) return tool;
    }
    return undefined;
  }

  async callTool(name: string, args: Record<string, unknown>, context?: ToolCallContextV1): Promise<{ content: string; isError: boolean }> {
    const signal = this.signal && context?.signal
      ? AbortSignal.any([this.signal, context.signal]) : this.signal ?? context?.signal;
    signal?.throwIfAborted();
    for (const provider of this.providers.values()) {
      const tool = provider.findTool(name);
      if (tool) {
        return abortableV1(signal, () => provider.callTool(name, args, { signal }));
      }
    }
    throw new Error(`Tool '${name}' not found`);
  }
}
