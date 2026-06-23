export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolProvider {
  id: string; // "base-mcp" | "moralis" | "native" | ...
  listTools(): Promise<ToolDef[]>; // catalog, filtered by isProtocolEnabled(id)
  findTool(name: string): ToolDef | undefined;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }>;
}
