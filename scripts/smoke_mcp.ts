import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// T72 §8 — the MCP endpoint, exercised the way Claude, ChatGPT and Codex will.
//
// Read-only against a RUNNING server: it lists tools, asks for the pipeline
// status, and checks that a malformed address is refused. It signs nothing and
// cannot: there is no tool on this surface that could.
//
//   pnpm smoke:mcp                      # http://127.0.0.1:3000/mcp
//   MIORAIL_MCP_URL=https://host/mcp pnpm smoke:mcp
// ---------------------------------------------------------------------------

const url = process.env.MIORAIL_MCP_URL?.trim() || 'http://127.0.0.1:3000/mcp';

/** The three sentences that must reach any assistant that connects. */
const REQUIRED_CAVEATS_V1 = [
  'PROVISIONAL IS NOT QUALIFIED',
  'NO SUPPORTED ROUTE DOES NOT MEAN NO ROUTE',
  'EXIT CAPACITY IS MEASURED, NOT INTERPOLATED',
];

const EXPECTED_TOOLS_V1 = [
  'miorail_discover_status',
  'miorail_explain_b20_rejection',
  'miorail_get_b20_market_leaders',
  'miorail_get_b20_opportunity',
  'miorail_list_b20_opportunities',
];

function textOf(result: unknown): string {
  return ((result as { content?: { text?: string }[] }).content ?? [])
    .map((entry) => entry.text ?? '')
    .join('\n');
}

async function main(): Promise<void> {
  // The URL is printed, never a header: an Authorization header does not belong
  // on this surface and must not be introduced by a smoke script either.
  console.log(`Miorail MCP smoke → ${url}`);
  const client = new Client({ name: 'miorail-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  console.log(`  tools: ${names.join(', ')}`);
  const missing = EXPECTED_TOOLS_V1.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`missing tools: ${missing.join(', ')}`);

  for (const tool of tools) {
    for (const property of Object.keys(
      (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    )) {
      // §5 — the boundary, checked against a live server rather than a file.
      if (/wallet|account|owner|holder|signer/i.test(property)) {
        throw new Error(`${tool.name} accepts a wallet-shaped argument: ${property}`);
      }
    }
  }

  const status = await client.callTool({ name: 'miorail_discover_status', arguments: {} });
  const body = textOf(status);
  const parsed = JSON.parse(body) as { state?: string; emptyListMeaning?: string };
  console.log(`  pipeline: ${parsed.state}`);
  console.log(`  empty means: ${String(parsed.emptyListMeaning).slice(0, 100)}…`);
  for (const caveat of REQUIRED_CAVEATS_V1) {
    if (!body.includes(caveat)) throw new Error(`the status payload dropped: ${caveat}`);
  }

  const malformed = await client.callTool({
    name: 'miorail_get_b20_opportunity',
    arguments: { tokenAddress: 'not-an-address' },
  });
  if ((malformed as { isError?: boolean }).isError !== true) {
    throw new Error('a malformed address was not refused');
  }
  console.log('  malformed input: refused');

  // Nothing in a public payload may name an endpoint or a credential.
  for (const secret of ['postgres://', 'apiKey', 'Authorization', 'Bearer ']) {
    if (body.includes(secret)) throw new Error(`the payload leaked ${secret}`);
  }
  console.log('  payload: no endpoint, no credential');

  await client.close();
  console.log('OK');
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
