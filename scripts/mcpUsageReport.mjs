import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const INTERNAL = new Set(['brickbluebot', 'taifoon', 'internal', 'curl']);
const TOOLS = new Set(['miorail_discover_status', 'list_reviewed_stocks', 'get_representations',
  'compare_market_reality', 'get_market_changes', 'get_use_access', 'check_address_identity',
  'get_dividend_calendar', 'get_recorded_changes', 'get_reopen_round']);
const digest = value => createHash('sha256').update(value).digest('hex');
const actorHash = (surface, actor) => digest(`miorail-evidence-usage/v1|${surface}|${actor}`);
const family = ua => /brickbluebot/i.test(ua) ? 'brickbluebot' : /taifoon/i.test(ua) ? 'taifoon'
  : /b20.*verif|verif.*b20|miorail/i.test(ua) ? 'internal' : /curl\//i.test(ua) ? 'curl' : 'unclassified';
const CLF = /^(\S+) \S+ \S+ \[([^\]]+)\] "POST (\/mcp(?:\/private)?\/?) HTTP\/[\d.]+" (\d{3}) \S+ "(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)"/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function logTime(value) {
  const match = value.match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!match || !MONTHS.includes(match[2])) return NaN;
  const [, day, month, year, hour, minute, second, offset] = match;
  return Date.parse(`${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-${day}T${hour}:${minute}:${second}${offset.slice(0, 3)}:${offset.slice(3)}`);
}

/** Only aggregates leave this function. No raw address, IP, User-Agent,
 * fingerprint, URL, argument or journal line appears in its result. */
export async function mcpUsageReportV1({ nginxLines, journalLines, since, until, excludedActors = {} }) {
  const start = Date.parse(since), end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('invalid_report_window');
  const excluded = new Set(Object.entries(excludedActors).flatMap(([surface, actors]) =>
    ['public', 'connected'].includes(surface) && Array.isArray(actors)
      ? actors.filter(a => typeof a === 'string').map(a => actorHash(surface, a)) : []));
  const clientSets = { nginx: new Set(), public: new Set(), connected: new Set(), evidence: new Set() };
  const nginx = { publicPosts: 0, connectedPosts: 0, excludedPosts: 0, byFamily: {}, statusCounts: {} };
  let retainedFrom = null, retainedUntil = null;
  for await (const line of nginxLines) {
    // All access records establish retention; POST /mcp alone would mistake a
    // quiet day for a missing log. The standard combined format has no host.
    const at = logTime(line.match(/\[([^\]]+)\]/)?.[1] ?? '');
    if (!Number.isFinite(at)) continue;
    retainedFrom = retainedFrom === null ? at : Math.min(retainedFrom, at);
    retainedUntil = retainedUntil === null ? at : Math.max(retainedUntil, at);
    if (at < start || at >= end) continue;
    const match = line.match(CLF);
    if (!match) continue;
    const [, ip, , path, status, ua] = match;
    const surface = path.includes('/private') ? 'connected' : 'public';
    const kind = family(ua), actor = actorHash(surface, ip);
    nginx[surface === 'public' ? 'publicPosts' : 'connectedPosts']++;
    nginx.byFamily[kind] = (nginx.byFamily[kind] ?? 0) + 1;
    nginx.statusCounts[status] = (nginx.statusCounts[status] ?? 0) + 1;
    if (INTERNAL.has(kind) || excluded.has(actor) || excluded.has(actorHash('public', ip))) {
      nginx.excludedPosts++; continue;
    }
    if (status.startsWith('2')) {
      const fingerprint = digest(`${actor}|${ua.slice(0, 300)}`);
      clientSets.nginx.add(fingerprint);
      clientSets[surface].add(fingerprint);
    }
  }
  const evidence = { successfulReads: 0, excludedReads: 0, byTool: {}, byFamily: {} };
  let instrumentedFrom = null, instrumentedUntil = null;
  for await (const line of journalLines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.message !== 'MCP evidence read' || event.usageVersion !== 1 || !TOOLS.has(event.toolName)
      || !['public', 'connected'].includes(event.surface)
      || !/^[0-9a-f]{64}$/.test(event.actorFingerprint ?? '')
      || !/^[0-9a-f]{64}$/.test(event.clientFingerprint ?? '')) continue;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at)) continue;
    instrumentedFrom = instrumentedFrom === null ? at : Math.min(instrumentedFrom, at);
    instrumentedUntil = instrumentedUntil === null ? at : Math.max(instrumentedUntil, at);
    if (at < start || at >= end) continue;
    evidence.successfulReads++;
    // A closed vocabulary is also the output privacy boundary.
    const kind = [...INTERNAL, 'unclassified'].includes(event.clientFamily) ? event.clientFamily : 'unclassified';
    evidence.byFamily[kind] = (evidence.byFamily[kind] ?? 0) + 1;
    if (INTERNAL.has(kind) || excluded.has(event.actorFingerprint)) { evidence.excludedReads++; continue; }
    clientSets.evidence.add(event.clientFingerprint);
    evidence.byTool[event.toolName] = (evidence.byTool[event.toolName] ?? 0) + 1;
  }
  const iso = at => at === null ? null : new Date(at).toISOString();
  return {
    schemaVersion: 'mcp-evidence-usage-report/v1', window: { since: iso(start), until: iso(end) },
    nginx: { ...nginx, retainedFrom: iso(retainedFrom), retainedUntil: iso(retainedUntil),
      coversWindowStart: retainedFrom !== null && retainedFrom <= start,
      candidateClientFingerprints: clientSets.nginx.size,
      candidatePublicClientFingerprints: clientSets.public.size,
      candidateConnectedTransportFingerprints: clientSets.connected.size, virtualHostEstablished: false },
    evidence: { ...evidence, firstRetainedReadAt: iso(instrumentedFrom), lastRetainedReadAt: iso(instrumentedUntil),
      candidateClientFingerprints: clientSets.evidence.size },
    verifiedForeignPeople: null,
    limitations: [
      'Nginx POSTs include initialize, tools/list and failures; they do not establish a tool invocation. Combined logs do not establish the virtual host.',
      'Evidence events count successful server reads, not proof the client received the answer. Reads before instrumentation or outside retained journals cannot be reconstructed.',
      'Fingerprints are client groups, not verified people. User-Agent labels are self-reported. Operator identities must be supplied in a private exclusion file.',
      'Execution-audit aggregates are a separate authenticated-action source; they do not count free reads and cannot be added to these client counts.',
    ],
  };
}

async function* fileLines(files) {
  for (const file of files) {
    const input = createReadStream(file);
    const reader = createInterface({ input: file.endsWith('.gz') ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
    for await (const line of reader) yield line;
  }
}

async function main() {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  const allowed = new Set(['--since', '--until', '--nginx-dir', '--exclude-file', '--journal-stdin']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error('invalid_report_arguments');
    if (args[i] !== '--journal-stdin') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('missing_report_argument');
      i++;
    }
  }
  const directory = args.includes('--nginx-dir') ? value('--nginx-dir') : '/var/log/nginx';
  const files = (await readdir(directory)).filter(name => /^access\.log(?:\.\d+(?:\.gz)?)?$/.test(name)).sort().map(name => join(directory, name));
  const until = args.includes('--until') ? value('--until') : new Date().toISOString();
  const since = args.includes('--since') ? value('--since') : new Date(Date.parse(until) - 7 * 86_400_000).toISOString();
  const excludedActors = args.includes('--exclude-file') ? JSON.parse(await readFile(value('--exclude-file'), 'utf8')) : {};
  // Start consuming stdin only when the report reaches this iterator. A
  // readline interface created before scanning nginx loses early pipe lines.
  const journalLines = args.includes('--journal-stdin') ? (async function* () {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) yield line;
  })() : [];
  const report = await mcpUsageReportV1({ nginxLines: fileLines(files), journalLines, since, until, excludedActors });
  console.log(JSON.stringify({ ...report, sources: { nginxFilesRead: files.length, journalProvided: args.includes('--journal-stdin'),
    privateExclusionsProvided: args.includes('--exclude-file') } }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('mcp_usage_report_failed'); process.exitCode = 1; });
}
