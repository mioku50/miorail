import {
  loadSkillExecutor,
  normalizeProviderPayloadV1,
  providerPayloadErrorCodeV1,
  providerPayloadFailureCopyV1,
  providerRecordV1,
  providerRowsV1,
  type BaseMcpSkillExecutor,
  type ProviderPayloadOutcomeV1,
} from '@mioagent/runtime-skills';
import { baseMcpProviderCtaV1 } from '@mioagent/security';
import { extractCommerceIntentV1 } from '@mioagent/intent-engine';
import type { CommerceCatalogSourceV1 } from '@mioagent/commerce-engine';
import type { BaseMcpConsoleResultV1 } from './baseMcpConsole.js';
import { baseMcpConsoleArgsV1, baseMcpConsoleResultTextV1 } from './baseMcpConsole.js';
import { sanitizedToolErrorCode } from './streamReadRouting.js';
import {
  PostgresBaseMcpPluginSessionStoreV1,
  type BaseMcpPluginSessionStoreV1,
} from './baseMcpPluginSessionStore.js';
import { callVirtualsReviewedV1 } from './virtualsReviewedClient.js';
import { resolveCommerceCatalogSourceV1 } from './commerceRouteConfig.js';
import { moonwellAssetV1, printrQuoteInputV1 } from './baseMcpReadInputs.js';

// ---------------------------------------------------------------------------
// Reviewed Base plugin recipes.
//
// The plugin catalogue tells the user what a plugin can do. This module is the
// code-owned bridge from that catalogue entry to a pinned host/method/path.
// The model never receives a generic HTTP primitive and never invents an
// endpoint. A recipe either matches an explicit provider/example pair or this
// layer returns null and the ordinary read-only Base MCP console may answer.
// ---------------------------------------------------------------------------

export interface ReviewedPluginReadInputV1 {
  providerId?: string;
  exampleId?: string | null;
  message: string;
  walletAddress: string;
  userId?: string;
  sessionSecret?: string;
}

export const reviewedBaseMcpPluginRuntimeV1 = {
  loadSkillExecutor,
  resolveCommerceCatalogSource: resolveCommerceCatalogSourceV1 as () => CommerceCatalogSourceV1,
  sessions: new PostgresBaseMcpPluginSessionStoreV1() as BaseMcpPluginSessionStoreV1,
  callVirtuals: callVirtualsReviewedV1,
  now: () => new Date(),
};

function jsonPreviewV1(value: unknown): string {
  try {
    return JSON.stringify(redactReviewedOutputV1(value));
  } catch {
    return 'Plugin returned data that could not be serialized.';
  }
}

function redactReviewedOutputV1(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactReviewedOutputV1(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 20_000) : value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(access_?token|refresh_?token|token|authorization|cookie|secret|password|signature)$/iu.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = redactReviewedOutputV1(item, depth + 1);
    }
  }
  return output;
}

/**
 * Rows from a provider payload, whatever envelope it arrived in.
 *
 * Every reply builder used to reach for its own key — `payload.data`,
 * `payload.launches`, `payload.data.poolGetPools` — and each one answered "no
 * readable rows" when the shape surprised it. That sentence is about the
 * provider, and it was being printed about our own decoding. One normalizer
 * now handles the JSON-in-a-string, MCP-envelope and `{data: …}` cases, and
 * `reviewedRowsV1` below is the only place a read decides it has none.
 */
/** Keys that mark a single record as a row of its own — Moonwell answers one
 * market as `{success, data: {asset, mToken, …}}`, not as a one-element list. */
const SINGLE_ROW_MARKERS_V1: readonly string[] = [
  'asset',
  'symbol',
  'mToken',
  'agentId',
  'agent_id',
  'agentName',
  'agent_name',
];

function objectArrayV1(value: unknown, preferredKeys: readonly string[] = []): Record<string, unknown>[] | null {
  const normalized = normalizeProviderPayloadV1(value);
  const rows = providerRowsV1(normalized.value, [...preferredKeys, 'markets', 'agents', 'items']);
  if (rows) return rows;
  // A lone record under an envelope is still a row. Looking only at the OUTER
  // object is why a perfectly good single-market Moonwell response was
  // reported as "this response shape has no supported market rows".
  const single = providerRecordV1(normalized.value, preferredKeys)
    ?? (normalized.value && typeof normalized.value === 'object' && !Array.isArray(normalized.value)
      ? (normalized.value as Record<string, unknown>)
      : null);
  if (single && SINGLE_ROW_MARKERS_V1.some((key) => key in single)) return [single];
  return null;
}

export interface ReviewedCallResultV1 {
  tool: string;
  args: Record<string, unknown>;
  data: unknown;
  /** How the body decoded. Only `parsed` may be read as data. */
  payloadOutcome: ProviderPayloadOutcomeV1;
  byteLength: number;
}

/** An executor response that predates the payload fields is a stub handing
 * back data it already parsed. */
const DEFAULT_PAYLOAD_OUTCOME_V1: ProviderPayloadOutcomeV1 = 'parsed';

/**
 * The rows in a reviewed call result, or the exact reason there are none.
 *
 * Three outcomes, deliberately distinct, because collapsing them is the bug
 * this whole module was hardened for:
 *
 *   `read`     — rows, and how many.
 *   `unread`   — the payload never decoded (truncated, not JSON, empty). We
 *                say so, and claim nothing about what the provider holds.
 *   `no_rows`  — it decoded and genuinely carries no row of this shape.
 */
export function reviewedRowsV1(
  result: ReviewedCallResultV1 | undefined,
  displayName: string,
  preferredKeys: readonly string[] = [],
):
  | { kind: 'read'; rows: Record<string, unknown>[] }
  | { kind: 'unread'; reply: string; errorCode: string }
  | { kind: 'no_rows' } {
  if (!result) {
    return { kind: 'unread', reply: `${displayName} was not called on this request.`, errorCode: 'reviewed_read_not_attempted' };
  }
  if (result.payloadOutcome !== 'parsed') {
    return {
      kind: 'unread',
      reply: providerPayloadFailureCopyV1(displayName, result.payloadOutcome),
      errorCode: providerPayloadErrorCodeV1(result.payloadOutcome) ?? 'provider_payload_unreadable',
    };
  }
  const rows = objectArrayV1(result.data, preferredKeys);
  return rows ? { kind: 'read', rows } : { kind: 'no_rows' };
}

function firstDisplayV1(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function moonwellMarketsReplyV1(result: ReviewedCallResultV1 | undefined, asset: string): string {
  const read = reviewedRowsV1(result, 'Moonwell', ['markets']);
  if (read.kind === 'unread') return read.reply;
  if (read.kind === 'no_rows') {
    return `Moonwell answered the reviewed ${asset} market request and the response was read, but it carries no market row Miorail recognises. Its exact sanitized response is in the trace.`;
  }
  const rows = read.rows;
  const matched = rows.filter((row) => {
    const symbol = firstDisplayV1(row, ['symbol', 'asset', 'underlyingSymbol', 'marketSymbol']);
    return symbol?.toUpperCase() === asset.toUpperCase();
  });
  if (matched.length === 0) return `Moonwell returned no identified ${asset} market in this response. Other assets were not substituted.`;
  const shown = matched.slice(0, 12).map((row, index) => {
    const name = firstDisplayV1(row, ['symbol', 'asset', 'underlyingSymbol', 'marketSymbol', 'name']) ?? `market ${index + 1}`;
    const supply = firstDisplayV1(row, ['baseSupplyApy', 'supplyApy', 'supplyAPY', 'totalSupplyApr', 'supplyApr', 'supplyAPR', 'supplyRate']);
    const borrow = firstDisplayV1(row, ['baseBorrowApy', 'borrowApy', 'borrowAPY', 'totalBorrowApr', 'borrowApr', 'borrowAPR', 'borrowRate']);
    const liquidity = firstDisplayV1(row, ['liquidityUsd', 'liquidity', 'availableLiquidity', 'cash']);
    const facts = [supply ? `supply ${supply}` : null, borrow ? `borrow ${borrow}` : null, liquidity ? `liquidity ${liquidity}` : null]
      .filter(Boolean)
      .join(' · ');
    return `${index + 1}. ${name}${facts ? ` — ${facts}` : ''}`;
  });
  return [`Moonwell ${asset} supply markets on Base (live reviewed API read):`, ...shown].join('\n');
}

function moonwellAccountReplyV1(payloads: readonly { label: string; data: unknown }[]): string {
  return [
    'Moonwell returned the connected wallet’s live Base position/health data through reviewed endpoints.',
    ...payloads.map(({ label, data }) => `${label}: ${baseMcpConsoleResultTextV1(jsonPreviewV1(data))}`),
  ].join('\n');
}

function virtualsAgentsReplyV1(payload: unknown): string {
  const decoded = normalizeProviderPayloadV1(payload).value;
  const record = providerRecordV1(decoded);
  if ([decoded, record?.agents, record?.data].some(value => Array.isArray(value) && value.length === 0)) {
    return 'Virtuals returned an empty agent list for this authenticated wallet.';
  }
  const rows = objectArrayV1(payload);
  if (!rows) return 'Virtuals answered agent_list, but Miorail could not identify an agent list in the response. The wallet’s agents were not established.';
  if (rows.length === 0) return 'Virtuals returned an empty agent list for this authenticated wallet.';
  const shown = rows.slice(0, 25).map((row, index) => {
    const name = firstDisplayV1(row, ['name', 'agentName', 'agent_name']) ?? `agent ${index + 1}`;
    const id = firstDisplayV1(row, ['id', 'agentId', 'agent_id']);
    const status = firstDisplayV1(row, ['status', 'state']);
    return `${index + 1}. ${name}${id ? ` — ${id}` : ''}${status ? ` · ${status}` : ''}`;
  });
  return [`Virtuals agents for the authenticated Base Account:`, ...shown].join('\n');
}

/**
 * GMGN's own trending list, read as what it is.
 *
 * GMGN ranks by ITS market activity, over a window it chose, on a corpus
 * Miorail has not reviewed. Every one of those is a reason this can never be
 * phrased as a finding: no ranking language, no safety verdict, and none of
 * the honeypot / rug / sniper columns the payload also carries -- a provider's
 * risk flag repeated by us reads as our judgement, and it is not one.
 */
function gmgnTrendingReplyV1(result: ReviewedCallResultV1 | undefined): string {
  const read = reviewedRowsV1(result, 'GMGN', ['rank']);
  if (read.kind === 'unread') return read.reply;
  if (read.kind === 'no_rows') {
    return 'GMGN answered the public trending request and the response was read, but it carries no token rows.';
  }
  const rows = read.rows.slice(0, 5);
  const named = rows
    .map((row) => {
      const symbol = firstDisplayV1(row, ['symbol', 'name']) ?? 'unnamed';
      const address = firstDisplayV1(row, ['address']);
      return address ? `${symbol} (${address})` : symbol;
    })
    .join(', ');
  return [
    `GMGN's own one-hour trending list for Base, by its volume ordering: ${named}.`,
    'These are GMGN\u2019s numbers over a window GMGN chose, on tokens Miorail has not reviewed \u2014 not a Miorail measurement, not a ranking Miorail endorses, and not a statement that any of them can be entered or exited.',
    'To ask what one of them would actually cost, give Miorail its exact address.',
  ].join(' ');
}

function veniceModelsReplyV1(result: ReviewedCallResultV1 | undefined): string {
  const read = reviewedRowsV1(result, 'Venice');
  if (read.kind === 'unread') return read.reply;
  if (read.kind === 'no_rows') {
    return 'Venice answered the public model-catalogue request and the response was read, but it carries no model rows.';
  }
  const rows = read.rows;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const type = firstDisplayV1(row, ['type']) ?? 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  // Twenty-five enumerated ids used to follow this sentence, and on a 200-model
  // catalogue that is most of a screen of provider slugs — below which sat the
  // raw payload, and below THAT the thing the reader wanted to do next. The
  // shape of the catalogue is the answer; the roster is evidence, and evidence
  // now lives in the fold with the payload it came from.
  const PREVIEW_V1 = 5;
  const preview = rows.slice(0, PREVIEW_V1).map((row, index) => {
    const spec = row.model_spec && typeof row.model_spec === 'object'
      ? row.model_spec as Record<string, unknown>
      : {};
    const id = firstDisplayV1(row, ['id']) ?? `model ${index + 1}`;
    const name = firstDisplayV1(spec, ['name']);
    const type = firstDisplayV1(row, ['type']) ?? 'unknown';
    return `  ${name && name !== id ? name : id} · ${type}`;
  });
  const summary = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([type, count]) => `${type} ${count}`)
    .join(' · ');
  const remaining = rows.length - preview.length;
  return [
    'Venice model catalogue',
    `${rows.length} models available`,
    summary,
    '',
    `First ${preview.length} in provider order:`,
    ...preview,
    ...(remaining > 0
      ? ['', `The remaining ${remaining} are in the raw provider response below.`]
      : []),
    '',
    'This was a free public GET /models read. No x402 payment or inference request was made.',
  ].join('\n');
}

function bankrLaunchesReplyV1(result: ReviewedCallResultV1 | undefined): string {
  const read = reviewedRowsV1(result, 'Bankr', ['launches']);
  if (read.kind === 'unread') return read.reply;
  const rows = read.kind === 'read' ? read.rows : [];
  const eligible = rows.filter((row) => row.status === 'deployed' && String(row.chain).toLowerCase() === 'base').slice(0, 10);
  if (eligible.length === 0) return 'Bankr answered the reviewed launch-feed request. No deployed Base launch was present in the returned page.';
  const shown = eligible.map((row, index) => {
    const deployer = row.deployer && typeof row.deployer === 'object' ? row.deployer as Record<string, unknown> : {};
    const symbol = firstDisplayV1(row, ['tokenSymbol']) ?? '—';
    const name = firstDisplayV1(row, ['tokenName']) ?? 'Unnamed launch';
    const address = firstDisplayV1(row, ['tokenAddress']) ?? 'address unavailable';
    const handle = firstDisplayV1(deployer, ['xUsername']);
    const website = firstDisplayV1(row, ['websiteUrl']);
    return `${index + 1}. ${symbol} — ${name}${handle ? ` · @${handle.replace(/^@/u, '')}` : ''}${website ? ` · ${website}` : ''}\n   ${address}`;
  });
  return [
    `Latest deployed Bankr launches on Base (${eligible.length} shown from the live feed):`,
    ...shown,
    'Bankr metadata is user-supplied discovery data, not an endorsement. No token was bought and no metadata link was opened.',
  ].join('\n');
}

function bankrLaunchReplyV1(result: ReviewedCallResultV1 | undefined): string {
  if (!result) return 'Bankr was not called on this request.';
  if (result.payloadOutcome !== 'parsed') return providerPayloadFailureCopyV1('Bankr', result.payloadOutcome);
  const launch = providerRecordV1(normalizeProviderPayloadV1(result.data).value, ['launch']);
  if (!launch) return 'Bankr answered the address lookup and the response was read, but it carries no launch record for that address.';
  const deployer = launch.deployer && typeof launch.deployer === 'object' ? launch.deployer as Record<string, unknown> : {};
  const facts = [
    `Name: ${firstDisplayV1(launch, ['tokenName']) ?? 'not reported'}`,
    `Symbol: ${firstDisplayV1(launch, ['tokenSymbol']) ?? 'not reported'}`,
    `Address: ${firstDisplayV1(launch, ['tokenAddress']) ?? 'not reported'}`,
    `Launch type: ${firstDisplayV1(launch, ['launchType']) ?? 'not reported'}`,
    `Deployer: ${firstDisplayV1(deployer, ['xUsername']) ? `@${firstDisplayV1(deployer, ['xUsername'])!.replace(/^@/u, '')}` : firstDisplayV1(deployer, ['walletAddress']) ?? 'not reported'}`,
  ];
  return ['Bankr launch metadata for the requested Base address:', ...facts, 'This is provider-supplied discovery metadata. No swap was prepared.'].join('\n');
}

function balancerPoolsReplyV1(result: ReviewedCallResultV1 | undefined): string {
  const read = reviewedRowsV1(result, 'Balancer', ['poolGetPools']);
  if (read.kind === 'unread') return read.reply;
  const rows = read.kind === 'read' ? read.rows : [];
  const ethRows = rows.filter((row) => {
    const tokens = Array.isArray(row.poolTokens) ? row.poolTokens : [];
    return tokens.some((token) => {
      const symbol = token && typeof token === 'object' ? String((token as Record<string, unknown>).symbol ?? '') : '';
      return /(?:^|w|r|cb|waBas)eth/i.test(symbol);
    });
  }).slice(0, 10);
  if (ethRows.length === 0) return 'Balancer answered the reviewed Base pool query. No ETH-bearing pool remained in the returned page.';
  const shown = ethRows.map((row, index) => {
    const dynamic = row.dynamicData && typeof row.dynamicData === 'object' ? row.dynamicData as Record<string, unknown> : {};
    const aprItems = Array.isArray(dynamic.aprItems) ? dynamic.aprItems : [];
    const apr = aprItems.reduce((sum, item) => {
      const value = item && typeof item === 'object' ? Number((item as Record<string, unknown>).apr) : NaN;
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
    const tokens = Array.isArray(row.poolTokens)
      ? row.poolTokens.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).symbol === 'string'
        ? [String((item as Record<string, unknown>).symbol)] : [])
      : [];
    const tvl = firstDisplayV1(dynamic, ['totalLiquidity']);
    const name = firstDisplayV1(row, ['name', 'symbol']) ?? `pool ${index + 1}`;
    return `${index + 1}. ${name} · ${tokens.join('/')} · APR ${(apr * 100).toFixed(2)}%${tvl ? ` · TVL $${tvl}` : ''}`;
  });
  return [
    'ETH-bearing Balancer pools on Base, from the live reviewed poolGetPools read:',
    ...shown,
    'APR is the sum of Balancer’s returned aprItems for this observation. This read did not run the Balancer SDK, build calldata, or add liquidity.',
  ].join('\n');
}

function clawnchLaunchesReplyV1(result: ReviewedCallResultV1 | undefined, byVolume: boolean): string {
  // Two feeds, two row shapes: `/api/launches` returns `contractAddress`,
  // `/api/tokens` returns `address`. Both are read here rather than in two
  // near-identical functions that would drift apart.
  const read = reviewedRowsV1(result, 'Clawnch', ['launches', 'tokens']);
  if (read.kind === 'unread') return read.reply;
  if (read.kind === 'no_rows') {
    return `Clawnch answered the public ${byVolume ? 'token directory' : 'launch feed'} and the response was read, but it carries no rows.`;
  }
  const shown = read.rows.slice(0, 10).map((row, index) => {
    const symbol = firstDisplayV1(row, ['symbol']) ?? '—';
    const name = firstDisplayV1(row, ['name']) ?? 'Unnamed launch';
    const address = firstDisplayV1(row, ['contractAddress', 'address']) ?? 'address unavailable';
    const source = firstDisplayV1(row, ['source', 'agentName', 'agent']);
    const volume = firstDisplayV1(row, ['volume24h']);
    const marketCap = firstDisplayV1(row, ['marketCap']);
    const launchedAt = firstDisplayV1(row, ['launchedAt', 'createdAt']);
    const facts = byVolume
      ? [volume ? `24h volume ${volume}` : null, marketCap ? `mcap ${marketCap}` : null].filter(Boolean).join(' · ')
      : [source, launchedAt ? launchedAt.slice(0, 10) : null].filter(Boolean).join(' · ');
    return `${index + 1}. ${symbol} — ${name}${facts ? ` · ${facts}` : ''}\n   ${address}`;
  });
  return [
    byVolume
      ? `Clawnch tokens on Base by 24h volume (${shown.length} shown):`
      : `Latest Clawnch launches on Base (${shown.length} shown, newest first):`,
    ...shown,
    'Symbols and names are user-supplied and collide across launches — the contract address is the identity. No token was bought and no launch was prepared.',
  ].join('\n');
}

function flaunchCoinsReplyV1(result: ReviewedCallResultV1 | undefined): string {
  const read = reviewedRowsV1(result, 'Flaunch', ['coins']);
  if (read.kind === 'unread') return read.reply;
  if (read.kind === 'no_rows') {
    return 'Flaunch answered the newest-coins feed and the response was read, but it carries no coin rows.';
  }
  const shown = read.rows.slice(0, 10).map((row, index) => {
    const symbol = firstDisplayV1(row, ['symbol']) ?? '—';
    const name = firstDisplayV1(row, ['name']) ?? 'Unnamed coin';
    const address = firstDisplayV1(row, ['tokenAddress', 'address']) ?? 'address unavailable';
    const marketCap = firstDisplayV1(row, ['marketCapETH', 'marketCapUSD', 'marketCap']);
    const price = firstDisplayV1(row, ['priceETH', 'price']);
    const facts = [price ? `price ${price} ETH` : null, marketCap ? `mcap ${marketCap}` : null].filter(Boolean).join(' · ');
    return `${index + 1}. ${symbol} — ${name}${facts ? ` · ${facts}` : ''}\n   ${address}`;
  });
  return [
    `Newest Flaunch coins on Base (${shown.length} shown from the live feed):`,
    ...shown,
    'Flaunch metadata is provider-supplied discovery data, not an endorsement. No swap was prepared and no launch was submitted.',
  ].join('\n');
}

async function runVirtualsReadV1(input: ReviewedPluginReadInputV1): Promise<BaseMcpConsoleResultV1 | null> {
  if (input.exampleId !== 'agents') return null;
  const checkedAt = reviewedBaseMcpPluginRuntimeV1.now().toISOString();
  if (!input.userId || !input.sessionSecret) return null;
  const session = await reviewedBaseMcpPluginRuntimeV1.sessions.load({
    userId: input.userId,
    sessionSecret: input.sessionSecret,
  });
  if (!session || session.stage !== 'authenticated' || session.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
    return {
      status: 'answered',
      reply: 'Virtuals needs a reviewed wallet sign-in before Miorail can list private agents. Use the Create Virtuals agent example to open Approve Sign-In; no provider request was sent for this read.',
      trace: [],
      toolsAvailable: 1,
      truncated: false,
      elapsedMs: 0,
      errorCode: null,
      checkedAt,
    };
  }
  const startedAt = Date.now();
  const response = await reviewedBaseMcpPluginRuntimeV1.callVirtuals({
    method: 'agent_list',
    args: { token: session.token },
  });
  if (!response.ok) {
    if (response.errorCode === 'virtuals_session_expired') await reviewedBaseMcpPluginRuntimeV1.sessions.clear(input.userId);
    return {
      status: 'failed',
      reply: 'Virtuals did not return the authenticated agent list. No alternate host or method was attempted.',
      trace: [{
        tool: 'virtuals_agent_list',
        args: baseMcpConsoleArgsV1(JSON.stringify({ authenticatedSession: true })),
        ok: false,
        result: '',
        errorCode: response.errorCode,
      }],
      toolsAvailable: 1,
      truncated: false,
      elapsedMs: Date.now() - startedAt,
      errorCode: response.errorCode,
      checkedAt,
    };
  }
  const preview = jsonPreviewV1(response.data);
  return {
    status: 'answered',
    reply: virtualsAgentsReplyV1(response.data),
    trace: [{
      tool: 'virtuals_agent_list',
      args: baseMcpConsoleArgsV1(JSON.stringify({ authenticatedSession: true })),
      ok: true,
      result: baseMcpConsoleResultTextV1(preview),
      errorCode: null,
    }],
    toolsAvailable: 1,
    truncated: false,
    elapsedMs: Date.now() - startedAt,
    errorCode: null,
    checkedAt,
  };
}

async function callReviewedV1(
  executor: BaseMcpSkillExecutor,
  calls: readonly {
    tool: string;
    path: string;
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutMs?: number;
    args: Record<string, unknown>;
  }[],
): Promise<{ results: ReviewedCallResultV1[]; error: BaseMcpConsoleResultV1 | null }> {
  const startedAt = Date.now();
  const results: ReviewedCallResultV1[] = [];
  for (const call of calls) {
    try {
      const response = await executor.request({
        path: call.path,
        method: call.method ?? 'GET',
        body: call.body,
        chainId: 8453,
        timeoutMs: call.timeoutMs,
      });
      if (response.status < 200 || response.status >= 300) {
        const raw = jsonPreviewV1(response.data);
        return {
          results,
          error: {
            status: 'failed',
            reply: 'The reviewed plugin endpoint answered, but it did not return a successful response. No fallback endpoint was invented.',
            trace: [{
              tool: call.tool,
              args: baseMcpConsoleArgsV1(JSON.stringify(call.args)),
              ok: false,
              result: baseMcpConsoleResultTextV1(raw),
              errorCode: `reviewed_plugin_http_${response.status}`,
            }],
            toolsAvailable: calls.length,
            truncated: false,
            elapsedMs: Date.now() - startedAt,
            errorCode: `reviewed_plugin_http_${response.status}`,
            checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
          },
        };
      }
      results.push({
        tool: call.tool,
        args: call.args,
        data: response.data,
        payloadOutcome: response.payloadOutcome ?? DEFAULT_PAYLOAD_OUTCOME_V1,
        byteLength: response.byteLength ?? 0,
      });
    } catch (error) {
      const code = sanitizedToolErrorCode(error instanceof Error ? error.message : String(error), 'reviewed_plugin_request_failed');
      return {
        results,
        error: {
          status: 'failed',
          reply: 'Miorail could not reach the reviewed plugin endpoint. No alternate host or unreviewed request was attempted.',
          trace: [{
            tool: call.tool,
            args: baseMcpConsoleArgsV1(JSON.stringify(call.args)),
            ok: false,
            result: '',
            errorCode: code,
          }],
          toolsAvailable: calls.length,
          truncated: false,
          elapsedMs: Date.now() - startedAt,
          errorCode: code,
          checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
        },
      };
    }
  }
  return { results, error: null };
}

async function runSimpleReviewedReadV1(input: {
  namespace: string;
  calls: readonly {
    tool: string;
    path: string;
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutMs?: number;
    args: Record<string, unknown>;
  }[];
  reply: (results: readonly ReviewedCallResultV1[]) => string;
  /** The plugin whose interface this answer can hand off to, and optionally the
   * object it read, so the CTA can deep-link instead of pointing at a home
   * page. Both come from THIS module — a reviewed builder that saw the
   * provider's own response — not from the model. */
  cta?: {
    pluginId: string;
    object?: (results: readonly ReviewedCallResultV1[]) => { id: string | null; name: string | null } | null;
  };
}): Promise<BaseMcpConsoleResultV1 | null> {
  const executor = reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor(input.namespace);
  if (!executor) return null;
  const startedAt = Date.now();
  const called = await callReviewedV1(executor, input.calls);
  if (called.error) return called.error;
  // A body that never decoded is a failed read wearing a 200. Reporting it as
  // `answered` with a null error code is how "no readable rows" got printed
  // over a payload that had them.
  const unreadable = called.results.find((result) => result.payloadOutcome !== 'parsed');
  const errorCode = unreadable ? providerPayloadErrorCodeV1(unreadable.payloadOutcome) : null;
  return {
    status: 'answered',
    reply: input.reply(called.results),
    trace: called.results.map((result) => ({
      tool: result.tool,
      args: baseMcpConsoleArgsV1(JSON.stringify(result.args)),
      ok: result.payloadOutcome === 'parsed',
      result: baseMcpConsoleResultTextV1(jsonPreviewV1(result.data)),
      errorCode: result.payloadOutcome === 'parsed' ? null : providerPayloadErrorCodeV1(result.payloadOutcome),
    })),
    toolsAvailable: input.calls.length,
    truncated: false,
    elapsedMs: Date.now() - startedAt,
    errorCode,
    checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
    cta: input.cta
      ? (() => {
          // A read that could not be decoded has no object to point at, and a
          // deep link built from a payload we failed to parse would be a guess.
          const object = errorCode === null && input.cta.object ? input.cta.object(called.results) : null;
          return baseMcpProviderCtaV1({
            pluginId: input.cta.pluginId,
            objectId: object?.id ?? null,
            objectName: object?.name ?? null,
          });
        })()
      : null,
  };
}

function avantisPositionsReplyV1(result: ReviewedCallResultV1 | undefined): string {
  if (!result) return 'Avantis was not called on this request.';
  if (result.payloadOutcome !== 'parsed') return providerPayloadFailureCopyV1('Avantis', result.payloadOutcome);
  const root = normalizeProviderPayloadV1(result.data).value;
  const record = root && typeof root === 'object' && !Array.isArray(root) ? root as Record<string, unknown> : {};
  const positions = Array.isArray(record.positions) ? record.positions.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object') : [];
  const orders = Array.isArray(record.limitOrders) ? record.limitOrders.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object') : [];
  if (positions.length === 0 && orders.length === 0) {
    return 'Avantis answered the trader-scoped read for your connected wallet: no open position and no resting limit order. This is a view-only read; nothing was opened, closed or changed.';
  }
  const shown = positions.slice(0, 12).map((row, index) => {
    const pair = firstDisplayV1(row, ['pairIndex', 'pair', 'market', 'symbol']) ?? `position ${index + 1}`;
    const leverage = firstDisplayV1(row, ['leverage']);
    const side = row.buy === true ? 'long' : row.buy === false ? 'short' : null;
    const collateral = firstDisplayV1(row, ['positionSizeUSDC', 'collateral', 'initialPosToken']);
    const pnl = firstDisplayV1(row, ['pnl', 'profitLoss', 'netPnl']);
    const facts = [side, leverage ? `${leverage}x` : null, collateral ? `size ${collateral}` : null, pnl ? `PnL ${pnl}` : null].filter(Boolean).join(' · ');
    return `${index + 1}. ${pair}${facts ? ` — ${facts}` : ''}`;
  });
  return [
    `Avantis positions for your connected wallet (${positions.length} open, ${orders.length} resting limit order${orders.length === 1 ? '' : 's'}):`,
    ...shown,
    'Leverage can liquidate a position. This is a view-only read through the reviewed trader endpoint; nothing was opened, closed or changed.',
  ].join('\n');
}

function printrQuoteReplyV1(result: ReviewedCallResultV1 | undefined): string {
  if (!result) return 'Printr was not called on this request.';
  if (result.payloadOutcome !== 'parsed') return providerPayloadFailureCopyV1('Printr', result.payloadOutcome);
  const quote = providerRecordV1(normalizeProviderPayloadV1(result.data).value, ['quote']);
  if (!quote) return 'Printr answered the launch-cost request and the response was read, but it carries no quote.';
  const costs = Array.isArray(quote.costs) ? quote.costs.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object') : [];
  const lines = costs.slice(0, 8).map((row, index) => {
    const chain = firstDisplayV1(row, ['chain', 'chain_id', 'chainId']) ?? `chain ${index + 1}`;
    const usd = firstDisplayV1(row, ['cost_usd', 'costUsd']);
    const atomic = firstDisplayV1(row, ['cost_asset_atomic', 'costAssetAtomic']);
    return `${index + 1}. ${chain}${usd ? ` — $${usd}` : ''}${atomic ? ` · ${atomic} atomic` : ''}`;
  });
  return [
    'Printr launch cost for the requested chains (live reviewed quote read):',
    ...(lines.length > 0 ? lines : ['The quote carries no per-chain cost row.']),
    'This is a cost quote only. No token was deployed and no calldata was built.',
  ].join('\n');
}


function openseaCollectionsReplyV1(result: ReviewedCallResultV1 | undefined): string {
  const read = reviewedRowsV1(result, 'OpenSea', ['collections']);
  if (read.kind === 'unread') return read.reply;
  if (read.kind === 'no_rows') {
    return 'OpenSea answered the Base collection request and the response was read, but it carries no collection rows.';
  }
  const shown = read.rows.slice(0, 10).map((row, index) => {
    const name = firstDisplayV1(row, ['name']) ?? `collection ${index + 1}`;
    const slug = firstDisplayV1(row, ['collection']);
    const contracts = Array.isArray(row.contracts) ? row.contracts : [];
    const address = contracts
      .flatMap((entry) => (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).address === 'string'
        ? [String((entry as Record<string, unknown>).address)] : []))[0];
    return `${index + 1}. ${name}${slug ? ` · ${slug}` : ''}${address ? `\n   ${address}` : ''}`;
  });
  return [
    `OpenSea collections on Base (${shown.length} shown):`,
    ...shown,
    'A collection listing is discovery data. Buying an NFT goes through the NFT route family and its own Safety Kernel; nothing was purchased here.',
  ].join('\n');
}

const BITREFILL_BROWSE_LIMIT_V1 = 20;

/** What Bitrefill carries in a market, when the user named no product. */
async function runBitrefillBrowseV1(input: {
  extraction: ReturnType<typeof extractCommerceIntentV1>;
  startedAt: number;
  checkedAt: string;
}): Promise<BaseMcpConsoleResultV1> {
  const { extraction, startedAt, checkedAt } = input;
  const country = extraction.country!;
  const source = reviewedBaseMcpPluginRuntimeV1.resolveCommerceCatalogSource();
  const args = { country, kind: extraction.kind, limit: BITREFILL_BROWSE_LIMIT_V1 };
  const trace = (ok: boolean, result: string, errorCode: string | null) => [{
    tool: 'bitrefill_catalogue_browse',
    args: baseMcpConsoleArgsV1(JSON.stringify(args)),
    ok,
    result,
    errorCode,
  }];
  if (!source.browse) {
    return {
      status: 'answered',
      reply: `Miorail can search Bitrefill for a named product, and this catalogue source exposes no browse. Name a product — for example “Find a 20 USD Steam ${country} gift card on Bitrefill.” No catalogue request was sent.`,
      trace: [], toolsAvailable: 1, truncated: false, elapsedMs: Date.now() - startedAt,
      errorCode: 'commerce_browse_unsupported', checkedAt,
    };
  }
  const result = await source.browse({
    kind: extraction.kind,
    country,
    limit: BITREFILL_BROWSE_LIMIT_V1,
    now: reviewedBaseMcpPluginRuntimeV1.now(),
  });
  if (!result.ok) {
    const reached = result.reason === 'product_not_found';
    return {
      status: 'answered',
      reply: reached
        ? `Bitrefill’s catalogue was reached and it lists no ${extraction.kind.replace('_', ' ')} for ${country}. No checkout or payment was opened.`
        : `Bitrefill could not complete this catalogue browse (${result.reason}). No checkout or payment was opened.`,
      trace: trace(reached, reached ? baseMcpConsoleResultTextV1('Catalogue reached; no product listed for this market.') : '', reached ? null : result.reason),
      toolsAvailable: 1, truncated: false, elapsedMs: Date.now() - startedAt,
      errorCode: reached ? null : result.reason, checkedAt,
    };
  }
  const lines = result.products.map((product, index) => {
    const values = product.packageValues.length > 0
      ? `${product.packageValues.slice(0, 6).join('/')} ${product.currency}`
      : 'denominations not listed';
    return `${index + 1}. ${product.name} · ${values} · ${product.availability}`;
  });
  return {
    status: 'answered',
    reply: [
      `${result.providerDisplayName} catalogue for ${country}: ${result.products.length} ${extraction.kind.replace('_', ' ')} product${result.products.length === 1 ? '' : 's'} shown.`,
      ...lines,
      'Denominations are what the storefront lists; a settlement price is only quoted once you name one. This is a catalogue read only — no invoice was created and no payment was requested.',
    ].join('\n'),
    trace: trace(true, baseMcpConsoleResultTextV1(jsonPreviewV1({ country, observedAt: result.observedAt, products: result.products })), null),
    toolsAvailable: 1, truncated: false, elapsedMs: Date.now() - startedAt,
    errorCode: null, checkedAt,
  };
}

async function runBitrefillReadV1(input: ReviewedPluginReadInputV1): Promise<BaseMcpConsoleResultV1> {
  const startedAt = Date.now();
  const checkedAt = reviewedBaseMcpPluginRuntimeV1.now().toISOString();
  const extraction = extractCommerceIntentV1(input.message);
  if (!extraction.country) {
    return {
      status: 'answered',
      reply: 'Name the country, for example “Browse Bitrefill gift cards in the United States.” Bitrefill’s catalogue differs by market, so Miorail will not pick one. No catalogue request was sent.',
      trace: [], toolsAvailable: 1, truncated: false, elapsedMs: Date.now() - startedAt,
      errorCode: 'commerce_country_required', checkedAt,
    };
  }
  // No product named: that is a BROWSE, not a failed search. Sending the
  // sentence's leftover words to the storefront produced `query="Browse gift
  // available in"` and a "nothing found for the US" answer about a catalogue
  // holding thousands of products.
  if (!extraction.query) {
    return runBitrefillBrowseV1({ ...input, extraction, startedAt, checkedAt });
  }
  const result = await reviewedBaseMcpPluginRuntimeV1.resolveCommerceCatalogSource().search({
    query: extraction.query,
    kind: extraction.kind,
    country: extraction.country,
    requestedValueDecimal: extraction.denominationDecimal ?? '1',
    requestedCurrency: extraction.currency ?? 'USD',
    now: reviewedBaseMcpPluginRuntimeV1.now(),
  });
  if (!result.ok) {
    const reached = ['product_not_found', 'denomination_unavailable', 'product_out_of_stock'].includes(result.reason);
    const reply = result.reason === 'product_not_found'
      ? `Bitrefill’s live catalogue was reached, but it currently returned no ${extraction.query} product for ${extraction.country}. No checkout or payment was opened.`
      : result.reason === 'provider_payment_required'
        ? 'Bitrefill requires a connected SIWX session or a separately approved x402 catalogue fee for this read. Miorail did not pay it automatically.'
        : `Bitrefill could not complete this reviewed catalogue read (${result.reason}). No checkout or payment was opened.`;
    return {
      status: 'answered', reply,
      trace: [{
        tool: 'bitrefill_catalogue_search',
        args: baseMcpConsoleArgsV1(JSON.stringify({ query: extraction.query, country: extraction.country, kind: extraction.kind })),
        ok: reached,
        result: reached ? baseMcpConsoleResultTextV1('Catalogue reached; no matching purchasable package.') : '',
        errorCode: reached ? null : result.reason,
      }],
      toolsAvailable: 1, truncated: false, elapsedMs: Date.now() - startedAt,
      errorCode: reached ? null : result.reason, checkedAt,
    };
  }
  const packages = result.observation.packages;
  const requested = extraction.denominationDecimal;
  const exact = requested ? packages.filter((entry) => entry.product.packageValue === requested) : packages;
  const shown = (exact.length > 0 ? exact : packages).slice(0, 12);
  const reply = [
    `${result.observation.providerDisplayName} live catalogue: ${shown[0]?.product.name ?? extraction.query} · ${extraction.country}.`,
    ...(requested && exact.length === 0
      ? [`The requested ${requested} ${extraction.currency ?? 'USD'} denomination was not returned. Available packages are shown instead.`]
      : []),
    ...shown.map((entry, index) => `${index + 1}. ${entry.product.packageValue} ${entry.product.currency} · ${entry.availability} · settlement ${entry.fees.totalBasis === 'exact_quote' ? 'quoted' : 'minimum'} ${Number(entry.fees.totalAtomic) / 1_000_000} USDC`),
    'This is a catalogue read only. No invoice was created and no payment was requested.',
  ].join('\n');
  return {
    status: 'answered', reply,
    trace: [{
      tool: 'bitrefill_catalogue_search',
      args: baseMcpConsoleArgsV1(JSON.stringify({ query: extraction.query, country: extraction.country, kind: extraction.kind })),
      ok: true,
      result: baseMcpConsoleResultTextV1(jsonPreviewV1({
        provider: result.observation.providerId,
        endpoint: result.observation.endpoint,
        observedAt: result.observation.observedAt,
        packages: shown,
      })),
      errorCode: null,
    }],
    toolsAvailable: 1, truncated: false, elapsedMs: Date.now() - startedAt,
    errorCode: null, checkedAt,
  };
}

function readNeedsInputV1(errorCode: string, reply: string): BaseMcpConsoleResultV1 {
  return { status: 'answered', reply, trace: [], toolsAvailable: 0, truncated: false,
    elapsedMs: 0, errorCode, checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString() };
}

export async function runReviewedBaseMcpPluginReadV1(
  input: ReviewedPluginReadInputV1,
): Promise<BaseMcpConsoleResultV1 | null> {
  if (input.providerId === 'virtuals') return runVirtualsReadV1(input);
  if (input.providerId === 'venice' && input.exampleId === 'models') {
    return runSimpleReviewedReadV1({
      namespace: 'venice',
      calls: [{ tool: 'venice_get_models', path: '/api/v1/models?type=all', timeoutMs: 7_000, args: { type: 'all' } }],
      reply: (results) => veniceModelsReplyV1(results[0]),
      cta: { pluginId: 'venice' },
    });
  }
  if (input.providerId === 'bankr' && ['latest', 'inspect'].includes(input.exampleId ?? '')) {
    const address = input.message.match(/0x[a-fA-F0-9]{40}/u)?.[0] ?? null;
    if (input.exampleId === 'inspect' && !address) {
      return {
        status: 'answered', reply: 'Paste the exact Base token address (0x…) to inspect it in Bankr’s launch index. No provider request was sent.',
        trace: [], toolsAvailable: 1, truncated: false, elapsedMs: 0, errorCode: null,
        checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
      };
    }
    return runSimpleReviewedReadV1({
      namespace: 'bankr',
      calls: [{
        tool: address ? 'bankr_get_launch' : 'bankr_get_launches',
        path: address ? `/token-launches/${encodeURIComponent(address)}` : '/token-launches',
        timeoutMs: 7_000,
        args: address ? { chain: 'base', address } : { chain: 'base', limit: 10 },
      }],
      reply: (results) => (address ? bankrLaunchReplyV1(results[0]) : bankrLaunchesReplyV1(results[0])),
      cta: { pluginId: 'bankr' },
    });
  }
  if (input.providerId === 'avantis' && input.exampleId === 'positions') {
    return runSimpleReviewedReadV1({
      namespace: 'avantis',
      calls: [{
        tool: 'avantis_get_positions',
        path: `/user-data?trader=${encodeURIComponent(input.walletAddress)}`,
        timeoutMs: 9_000,
        args: { chain: 'base', trader: input.walletAddress },
      }],
      reply: (results) => avantisPositionsReplyV1(results[0]),
      cta: { pluginId: 'avantis' },
    });
  }
  if (input.providerId === 'printr' && input.exampleId === 'status') {
    const ids = [...new Set(input.message.match(/\b0x[a-fA-F0-9]{1,128}\b/g) ?? [])];
    if (ids.length === 1) return runSimpleReviewedReadV1({
      namespace: 'printr',
      calls: [{ tool: 'printr_get_deployments', path: `/v0/tokens/${ids[0]}/deployments`,
        timeoutMs: 9_000, args: { tokenId: ids[0] } }],
      reply: results => {
        const result = results[0];
        if (!result || result.payloadOutcome !== 'parsed') return 'Printr deployment status could not be read. No deployment outcome was established.';
        return `Printr deployment response for token ${ids[0]}:\n${baseMcpConsoleResultTextV1(jsonPreviewV1(result.data))}`;
      },
      cta: { pluginId: 'printr' },
    });
    // Printr indexes a deployment by the token id it returned at launch, not
    // by wallet. Without one there is nothing to look up, so the answer names
    // the id rather than reaching for an endpoint that cannot answer.
    return {
      status: 'answered',
      reply: 'Printr looks up a deployment by the token id it returned when the launch was built, not by wallet. Give that id and Miorail will read its per-chain deployment status. No provider request was sent.',
      trace: [], toolsAvailable: 1, truncated: false, elapsedMs: 0,
      errorCode: 'printr_token_id_required',
      checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
    };
  }
  if (input.providerId === 'printr' && input.exampleId === 'cost') {
    const quoteInput = printrQuoteInputV1(input.message);
    if (!quoteInput) return readNeedsInputV1('printr_quote_inputs_required',
      'Specify the chains, initial buy in USD, and graduation target per chain (15000–1000000 USD). Format: “Printr launch cost on Base and Arbitrum, initial buy <amount> USD, graduation target <amount> USD”. No budget or chain was substituted and no provider request was sent.');
    return runSimpleReviewedReadV1({
      namespace: 'printr',
      calls: [{
        tool: 'printr_get_quote',
        path: '/v0/print/quote',
        method: 'POST',
        timeoutMs: 12_000,
        body: quoteInput,
        args: quoteInput,
      }],
      reply: (results) => printrQuoteReplyV1(results[0]),
      cta: { pluginId: 'printr' },
    });
  }
  if (input.providerId === 'gmgn') {
    // GMGN's only per-token endpoint returns swap CALLDATA, which this surface
    // does not release: calldata no route family priced is not something
    // Extensions hands anybody. What it can answer is GMGN's own market list.
    return runSimpleReviewedReadV1({
      namespace: 'gmgn',
      calls: [{
        tool: 'gmgn_get_trending',
        path: '/v1/market/rank?chain=base&interval=1h&limit=10&order_by=volume',
        timeoutMs: 12_000,
        args: { chain: 'base', interval: '1h', limit: 10, order_by: 'volume' },
      }],
      reply: (results) => gmgnTrendingReplyV1(results[0]),
      cta: { pluginId: 'gmgn' },
    });
  }
  if (input.providerId === 'opensea' && input.exampleId === 'listing') {
    // A listing is about ONE token. Answering with a collection list would be
    // a different question wearing this one's answer.
    const address = input.message.match(/0x[a-fA-F0-9]{40}/u)?.[0] ?? null;
    return {
      status: 'answered',
      reply: address
        ? `Miorail reads OpenSea listings through the NFT route family, where a listing is priced, checked and fulfilled under its own Safety Kernel. Ask for it there with ${address} and the token id. This Extensions read lists Base collections only.`
        : 'Give the NFT contract address (0x…) and its token id. A listing is priced for one token, and Miorail will not answer for a collection as if it were one. No provider request was sent.',
      trace: [], toolsAvailable: 1, truncated: false, elapsedMs: 0,
      errorCode: address ? null : 'opensea_token_required',
      checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
    };
  }
  if (input.providerId === 'opensea' && input.exampleId === 'drops') {
    if (/\b(?:upcoming|drops?)\b/i.test(input.message)) return readNeedsInputV1('opensea_drops_unavailable',
      'This reviewed OpenSea read lists popular Base collections, not upcoming drops. Ask “Show popular NFT collections on Base from OpenSea” to read that catalogue.');
    return runSimpleReviewedReadV1({
      namespace: 'opensea',
      calls: [{
        tool: 'opensea_get_collections',
        path: '/api/v2/collections?chain=base&limit=10&order_by=seven_day_volume',
        timeoutMs: 9_000,
        args: { chain: 'base', limit: 10, orderBy: 'seven_day_volume' },
      }],
      reply: (results) => openseaCollectionsReplyV1(results[0]),
      // A list answer gets the provider's index, not the first row's page: a
      // deep link to whichever collection happened to sort first would tell the
      // reader that row was the point.
      cta: { pluginId: 'opensea' },
    });
  }
  if (input.providerId === 'clawnch' && ['latest', 'volume'].includes(input.exampleId ?? '')) {
    const byVolume = input.exampleId === 'volume';
    return runSimpleReviewedReadV1({
      namespace: 'clawnch',
      calls: [{
        tool: byVolume ? 'clawnch_get_tokens' : 'clawnch_get_launches',
        path: byVolume ? '/api/tokens?limit=10&sort=volume&prices=1' : '/api/launches?limit=10',
        timeoutMs: 9_000,
        args: { chain: 'base', limit: 10, ...(byVolume ? { sort: 'volume', prices: 1 } : {}) },
      }],
      reply: (results) => clawnchLaunchesReplyV1(results[0], byVolume),
      cta: { pluginId: 'clawnch' },
    });
  }
  if (input.providerId === 'flaunch' && input.exampleId === 'latest') {
    return runSimpleReviewedReadV1({
      namespace: 'flaunch',
      calls: [{ tool: 'flaunch_get_coins', path: '/v1/base/coins/new', timeoutMs: 9_000, args: { chain: 'base', order: 'new' } }],
      reply: (results) => flaunchCoinsReplyV1(results[0]),
      cta: { pluginId: 'flaunch' },
    });
  }
  if (input.providerId === 'balancer' && input.exampleId === 'yield') {
    if (!/\b(?:ETH|WETH)\b/i.test(input.message)) return readNeedsInputV1('balancer_asset_scope_required',
      'This reviewed Balancer pool read supports ETH-bearing pools on Base. Name ETH or WETH to use it; another asset will not be substituted.');
    const query = `query Pools($first: Int, $orderBy: GqlPoolOrderBy, $orderDirection: GqlPoolOrderDirection, $where: GqlPoolFilter) { poolGetPools(first: $first, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) { id address chain type name symbol protocolVersion dynamicData { totalLiquidity volume24h aprItems { apr type } } poolTokens { address symbol weight } } }`;
    return runSimpleReviewedReadV1({
      namespace: 'balancer',
      calls: [{
        tool: 'balancer_get_pools', path: '/', method: 'POST', timeoutMs: 7_000,
        body: { query, variables: { first: 25, orderBy: 'apr', orderDirection: 'desc', where: { chainIn: ['BASE'], minTvl: 100_000 } } },
        args: { chain: 'BASE', first: 25, orderBy: 'apr', minTvl: 100_000, assetFilter: 'ETH' },
      }],
      reply: (results) => balancerPoolsReplyV1(results[0]),
      cta: { pluginId: 'balancer' },
    });
  }
  if (input.providerId === 'bitrefill' && ['browse', 'search'].includes(input.exampleId ?? '')) {
    return runBitrefillReadV1(input);
  }
  if (input.providerId !== 'moonwell') return null;
  const asset = input.exampleId === 'markets' ? moonwellAssetV1(input.message) : null;
  if (input.exampleId === 'markets' && !asset) return readNeedsInputV1('moonwell_asset_required',
    'Name one asset for the Moonwell market read, for example “Show Moonwell USDC supply markets on Base”. No asset was substituted.');
  const executor = reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor('moonwell');
  if (!executor) return null;
  const startedAt = Date.now();

  const calls = input.exampleId === 'health'
    ? [
        {
          tool: 'moonwell_get_positions',
          path: `/v1/positions/${encodeURIComponent(input.walletAddress)}?chain=base&active=true`,
          args: { chain: 'base', address: input.walletAddress, active: true },
        },
        {
          tool: 'moonwell_get_health',
          path: `/v1/health/${encodeURIComponent(input.walletAddress)}?chain=base`,
          args: { chain: 'base', address: input.walletAddress },
        },
      ]
    : input.exampleId === 'markets'
      ? [{
          tool: 'moonwell_get_markets',
          path: `/v1/markets/${encodeURIComponent(asset!)}?chain=base`,
          args: { chain: 'base', asset: asset! },
        }]
      : null;
  if (!calls) return null;

  const called = await callReviewedV1(executor, calls);
  if (called.error) return called.error;
  const trace = called.results.map((result) => ({
    tool: result.tool,
    args: baseMcpConsoleArgsV1(JSON.stringify(result.args)),
    ok: true,
    result: baseMcpConsoleResultTextV1(jsonPreviewV1(result.data)),
    errorCode: null,
  }));
  return {
    status: 'answered',
    reply: input.exampleId === 'health'
      ? moonwellAccountReplyV1(called.results.map((result) => ({ label: result.tool, data: result.data })))
      : moonwellMarketsReplyV1(called.results[0], asset!),
    trace,
    toolsAvailable: calls.length,
    truncated: false,
    elapsedMs: Date.now() - startedAt,
    errorCode: null,
    checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
  };
}
