// ---------------------------------------------------------------------------
// Regenerate the Base MCP plugin catalogue from Base's published specs.
//
// Run by hand, never at request time:
//
//   node --import tsx scripts/refreshBaseMcpPluginCatalogue.mts
//
// The output is COMMITTED. That is the point: the set of hosts Miorail may
// reach is a security boundary, and a boundary that refreshes itself from the
// network is one nobody reviews. Fetching it live would also mean an outage —
// or a compromise — at github.com silently widening or emptying the allowlist.
// Generating into a file puts every change in a diff someone has to read.
//
// What CAN be checked live, and is, is whether this file has fallen behind:
// `artifacts/api-server/lib/baseMcpPluginDrift.ts` compares the plugin NAMES
// Base publishes against the ones here and reports the gap. Names cannot widen
// an allowlist, so that check reads without granting anything.
//
// Two things changed on 2026-08-09, and both matter.
//
//   * The plugin list is DISCOVERED, not hardcoded. It used to be a literal
//     array in this file, which meant a plugin Base added stayed invisible
//     until someone noticed and typed its name.
//
//   * Hosts come from each spec's `requires.allowlist` — Base's own declared
//     allowlist — instead of a regex over the whole document. The regex was
//     reading marketing links and example output as endpoints: it produced
//     `opensea.io`, `www.bitrefill.com`, `hydrex.fi` and `clanker.world`, none
//     of which any plugin calls. An allowlist is only as good as what it
//     leaves out, and that one was letting in whatever a spec happened to
//     hyperlink.
// ---------------------------------------------------------------------------

const CONTENTS_API_V1 =
  'https://api.github.com/repos/base/skills/contents/skills/base-mcp/plugins';
const SPEC_BASE_V1 =
  'https://raw.githubusercontent.com/base/skills/master/skills/base-mcp/plugins';

/**
 * Hosts that must never enter the allowlist even if a spec declares one.
 *
 * Base's own allowlist is written for Base's runtime, not ours. Two of these
 * would route around credential handling Miorail does elsewhere.
 */
const NEVER_ALLOWLIST_V1 = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'docs.base.org',
  'basescan.org',
  'etherscan.io',
  'example.com',
  'localhost',
  // Reached through the MCP client, not through plugin HTTP.
  'mcp.base.org',
  // An RPC endpoint is not a plugin API, and ours is configured elsewhere.
  'mainnet.base.org',
  'sepolia.base.org',
  'base-rpc.publicnode.com',
]);

const HOSTNAME_V1 = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const PLUGIN_ID_V1 = /^[a-z0-9][a-z0-9-]{0,40}$/;

interface PluginSpec {
  id: string;
  title: string;
  summary: string;
  version: string;
  integration: string;
  chains: string[];
  tags: string[];
  risk: string[];
  auth: string;
  shell: string;
  hosts: string[];
  externalMcpHost: string | null;
  cliPackage: string | null;
}

// --- a very small YAML reader -----------------------------------------------
//
// Deliberately not a YAML dependency. The frontmatter these specs use is flat
// scalars, inline lists and one nested object two levels deep, and the specs
// are fetched from the network — a full parser is more attack surface than the
// job needs. Anything this reader does not understand comes back empty, and
// an empty field renders as "not stated" rather than as a guess.

/** ` # trailing comment`, which several specs put after a value. */
function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, '').trim();
}

function parseScalar(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let out = '';
    for (let index = 1; index < trimmed.length; index += 1) {
      const char = trimmed[index]!;
      if (char === '\\' && quote === '"' && index + 1 < trimmed.length) {
        out += trimmed[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) return out;
      out += char;
    }
    return out;
  }
  const bare = stripComment(trimmed);
  if (!bare || bare === 'null' || bare === '~') return null;
  return bare;
}

function parseInlineList(raw: string): string[] {
  const trimmed = stripComment(raw.trim());
  if (!trimmed.startsWith('[')) return [];
  const close = trimmed.indexOf(']');
  const inner = trimmed.slice(1, close === -1 ? trimmed.length : close);
  return inner
    .split(',')
    .map((entry) => parseScalar(entry) ?? '')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

interface Frontmatter {
  top: Map<string, string>;
  requires: Map<string, string>;
  externalMcp: Map<string, string>;
}

function readFrontmatter(markdown: string): Frontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;

  const top = new Map<string, string>();
  const requires = new Map<string, string>();
  const externalMcp = new Map<string, string>();

  let section: 'top' | 'requires' | 'externalMcp' = 'top';
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const pair = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    const [, key, value] = pair as unknown as [string, string, string];

    if (indent === 0) {
      section = key === 'requires' ? 'requires' : 'top';
      if (section === 'top') top.set(key, value);
      continue;
    }
    if (indent <= 2) {
      section = key === 'externalMcp' && !stripComment(value) ? 'externalMcp' : 'requires';
      if (section === 'requires') requires.set(key, value);
      continue;
    }
    if (section === 'externalMcp') externalMcp.set(key, value);
  }
  return { top, requires, externalMcp };
}

// --- the catalogue ----------------------------------------------------------

function safeHosts(pluginId: string, declared: string[]): string[] {
  const kept: string[] = [];
  for (const raw of declared) {
    const host = raw.trim().toLowerCase();
    if (!HOSTNAME_V1.test(host)) continue;
    if (NEVER_ALLOWLIST_V1.has(host)) {
      console.log(`  ${pluginId}: dropped ${host} (never allowlisted here)`);
      continue;
    }
    if (!kept.includes(host)) kept.push(host);
  }
  return kept.sort();
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).host.toLowerCase();
    return HOSTNAME_V1.test(host) ? host : null;
  } catch {
    return null;
  }
}

async function listPublishedPlugins(): Promise<string[]> {
  const response = await fetch(CONTENTS_API_V1, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`plugin directory listing failed: ${response.status}`);
  const entries = (await response.json()) as { name?: unknown; type?: unknown }[];
  if (!Array.isArray(entries)) throw new Error('plugin directory listing was not an array');
  return entries
    .filter((entry) => entry.type === 'file' && typeof entry.name === 'string')
    .map((entry) => String(entry.name).replace(/\.md$/, ''))
    .filter((id) => PLUGIN_ID_V1.test(id))
    .sort();
}

async function fetchSpec(plugin: string): Promise<string | null> {
  const response = await fetch(`${SPEC_BASE_V1}/${plugin}.md`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  return response.text();
}

function toSpec(id: string, markdown: string): PluginSpec | null {
  const front = readFrontmatter(markdown);
  if (!front) return null;
  const { top, requires, externalMcp } = front;

  return {
    id,
    title: parseScalar(top.get('title') ?? '') ?? id,
    summary: parseScalar(top.get('description') ?? '') ?? '',
    version: parseScalar(top.get('version') ?? '') ?? '',
    integration: parseScalar(top.get('integration') ?? '') ?? 'unknown',
    chains: parseInlineList(top.get('chains') ?? ''),
    tags: parseInlineList(top.get('tags') ?? ''),
    risk: parseInlineList(top.get('risk') ?? ''),
    auth: parseScalar(top.get('auth') ?? '') ?? 'unknown',
    shell: parseScalar(requires.get('shell') ?? '') ?? 'unknown',
    hosts: safeHosts(id, parseInlineList(requires.get('allowlist') ?? '')),
    externalMcpHost: hostOf(parseScalar(externalMcp.get('url') ?? '')),
    cliPackage: parseScalar(requires.get('cliPackage') ?? ''),
  };
}

function literal(value: string | null): string {
  if (value === null) return 'null';
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function listLiteral(values: readonly string[]): string {
  return `[${values.map((value) => literal(value)).join(', ')}]`;
}

async function main(): Promise<void> {
  const published = await listPublishedPlugins();
  const specs: PluginSpec[] = [];
  const missing: string[] = [];

  for (const id of published) {
    const markdown = await fetchSpec(id);
    const spec = markdown ? toSpec(id, markdown) : null;
    if (!spec) {
      missing.push(id);
      continue;
    }
    specs.push(spec);
  }

  const lines: string[] = [
    '// GENERATED by scripts/refreshBaseMcpPluginCatalogue.mts — do not edit by hand.',
    '//',
    '// The native Base MCP plugins, read from the frontmatter of the specs Base',
    '// publishes at github.com/base/skills. These are the same files Claude and',
    '// ChatGPT load, so this is exactly the catalogue those clients see.',
    '//',
    "// `hosts` is each spec's own `requires.allowlist` — what Base declares the",
    '// plugin calls — not every URL its documentation happens to mention.',
    '//',
    '// Committed rather than fetched: an allowlist that refreshes itself from the',
    '// network is one nobody reviews, and an outage at the source would silently',
    '// empty or widen it. Every change to this file arrives in a diff.',
    '//',
    `// Regenerated ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'export interface BaseMcpPluginSpecV1 {',
    '  /** Spec filename without the extension, e.g. `o1-exchange`. */',
    '  id: string;',
    '  title: string;',
    '  summary: string;',
    '  version: string;',
    "  /** `http-api` | `cli-only` | `hybrid` | `semantic-base-tool` | `unknown`. */",
    '  integration: string;',
    '  chains: readonly string[];',
    '  tags: readonly string[];',
    '  /** Base’s own risk labels: slippage, liquidation, irreversible, pii… */',
    '  risk: readonly string[];',
    '  auth: string;',
    "  /** `none` | `optional` | `required` | `bash` | `unknown`. */",
    '  shell: string;',
    '  /** Declared HTTP hosts. Empty means the plugin calls none. */',
    '  hosts: readonly string[];',
    '  /** A separate MCP server the plugin needs, if it names one. */',
    '  externalMcpHost: string | null;',
    '  cliPackage: string | null;',
    '}',
    '',
    'export const BASE_MCP_PLUGIN_CATALOGUE_V1: readonly BaseMcpPluginSpecV1[] = [',
  ];
  for (const spec of specs) {
    lines.push(
      '  {',
      `    id: ${literal(spec.id)},`,
      `    title: ${literal(spec.title)},`,
      `    summary: ${literal(spec.summary)},`,
      `    version: ${literal(spec.version)},`,
      `    integration: ${literal(spec.integration)},`,
      `    chains: ${listLiteral(spec.chains)},`,
      `    tags: ${listLiteral(spec.tags)},`,
      `    risk: ${listLiteral(spec.risk)},`,
      `    auth: ${literal(spec.auth)},`,
      `    shell: ${literal(spec.shell)},`,
      `    hosts: ${listLiteral(spec.hosts)},`,
      `    externalMcpHost: ${literal(spec.externalMcpHost)},`,
      `    cliPackage: ${literal(spec.cliPackage)},`,
      '  },',
    );
  }
  lines.push(
    '];',
    '',
    '/** The date the catalogue above was read from Base. */',
    `export const BASE_MCP_CATALOGUE_GENERATED_AT_V1 = '${new Date().toISOString().slice(0, 10)}';`,
    '',
    '/** The HTTP scope per plugin, derived from the catalogue so there is one source. */',
    'export const BASE_MCP_PLUGIN_HOSTS_V1: Readonly<Record<string, readonly string[]>> = Object.freeze(',
    '  Object.fromEntries(BASE_MCP_PLUGIN_CATALOGUE_V1.map((plugin) => [plugin.id, plugin.hosts])),',
    ');',
    '',
    '/** Every allowlisted host, flattened. */',
    'export const BASE_MCP_ALL_PLUGIN_HOSTS_V1: readonly string[] = Object.freeze(',
    '  [...new Set(BASE_MCP_PLUGIN_CATALOGUE_V1.flatMap((plugin) => plugin.hosts))].sort(),',
    ');',
    '',
  );

  const target = new URL('../lib/security/src/baseMcpPluginCatalogue.generated.ts', import.meta.url);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(target, lines.join('\n'), 'utf8');

  const hosts = new Set(specs.flatMap((spec) => spec.hosts)).size;
  console.log(`Wrote ${specs.length} plugins, ${hosts} distinct hosts.`);
  if (missing.length > 0) {
    // Named, never silently skipped: a plugin whose spec did not download is a
    // plugin that will not work, and the operator has to know which.
    console.log(`Spec not readable (left OUT of the catalogue): ${missing.join(', ')}`);
  }
}

await main();
