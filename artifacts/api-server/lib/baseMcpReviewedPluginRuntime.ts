import { loadSkillExecutor, type BaseMcpSkillExecutor } from '@mioagent/runtime-skills';
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

function objectArrayV1(value: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 5 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const rows = value.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    );
    return rows.length > 0 ? rows : null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['markets', 'agents', 'items', 'results', 'data']) {
    if (key in record) {
      const nested = objectArrayV1(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  if (['asset', 'symbol', 'mToken', 'agentId', 'agent_id', 'agentName', 'agent_name'].some((key) => key in record)) {
    return [record];
  }
  return null;
}

function firstDisplayV1(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function moonwellMarketsReplyV1(payload: unknown, asset: string): string {
  const rows = objectArrayV1(payload);
  if (!rows) {
    return `Moonwell answered the reviewed ${asset} market request. Its exact sanitized response is shown in the trace because this response shape has no supported market rows.`;
  }
  const matched = rows.filter((row) => {
    const symbol = firstDisplayV1(row, ['symbol', 'asset', 'underlyingSymbol', 'marketSymbol']);
    return !symbol || symbol.toUpperCase().includes(asset.toUpperCase());
  });
  const shown = (matched.length > 0 ? matched : rows).slice(0, 12).map((row, index) => {
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
  const rows = objectArrayV1(payload);
  if (!rows) return 'Virtuals answered the reviewed agent_list request. No agents were returned for this authenticated wallet.';
  const shown = rows.slice(0, 25).map((row, index) => {
    const name = firstDisplayV1(row, ['name', 'agentName', 'agent_name']) ?? `agent ${index + 1}`;
    const id = firstDisplayV1(row, ['id', 'agentId', 'agent_id']);
    const status = firstDisplayV1(row, ['status', 'state']);
    return `${index + 1}. ${name}${id ? ` — ${id}` : ''}${status ? ` · ${status}` : ''}`;
  });
  return [`Virtuals agents for the authenticated Base Account:`, ...shown].join('\n');
}

function veniceModelsReplyV1(payload: unknown): string {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rows = Array.isArray(record.data)
    ? record.data.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    : [];
  if (rows.length === 0) return 'Venice answered the public model-catalogue request, but returned no readable model rows.';
  const counts = new Map<string, number>();
  for (const row of rows) {
    const type = firstDisplayV1(row, ['type']) ?? 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const shown = rows.slice(0, 25).map((row, index) => {
    const spec = row.model_spec && typeof row.model_spec === 'object'
      ? row.model_spec as Record<string, unknown>
      : {};
    const id = firstDisplayV1(row, ['id']) ?? `model ${index + 1}`;
    const name = firstDisplayV1(spec, ['name']);
    const type = firstDisplayV1(row, ['type']) ?? 'unknown';
    return `${index + 1}. ${id}${name && name !== id ? ` — ${name}` : ''} · ${type}`;
  });
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type} ${count}`)
    .join(' · ');
  return [
    `Venice public model catalogue: ${rows.length} models (${summary}). Showing the first ${shown.length} in provider order:`,
    ...shown,
    'This was a free public GET /models read. No x402 payment or inference request was made.',
  ].join('\n');
}

function bankrLaunchesReplyV1(payload: unknown): string {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rows = Array.isArray(record.launches)
    ? record.launches.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    : [];
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

function bankrLaunchReplyV1(payload: unknown): string {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const launch = root.launch && typeof root.launch === 'object' ? root.launch as Record<string, unknown> : null;
  if (!launch) return 'Bankr answered the address lookup, but returned no readable launch record.';
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

function balancerPoolsReplyV1(payload: unknown): string {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {};
  const rows = Array.isArray(data.poolGetPools)
    ? data.poolGetPools.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    : [];
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
): Promise<{ results: { tool: string; args: Record<string, unknown>; data: unknown }[]; error: BaseMcpConsoleResultV1 | null }> {
  const startedAt = Date.now();
  const results: { tool: string; args: Record<string, unknown>; data: unknown }[] = [];
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
      results.push({ tool: call.tool, args: call.args, data: response.data });
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
  reply: (results: readonly { tool: string; args: Record<string, unknown>; data: unknown }[]) => string;
}): Promise<BaseMcpConsoleResultV1 | null> {
  const executor = reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor(input.namespace);
  if (!executor) return null;
  const startedAt = Date.now();
  const called = await callReviewedV1(executor, input.calls);
  if (called.error) return called.error;
  return {
    status: 'answered',
    reply: input.reply(called.results),
    trace: called.results.map((result) => ({
      tool: result.tool,
      args: baseMcpConsoleArgsV1(JSON.stringify(result.args)),
      ok: true,
      result: baseMcpConsoleResultTextV1(jsonPreviewV1(result.data)),
      errorCode: null,
    })),
    toolsAvailable: input.calls.length,
    truncated: false,
    elapsedMs: Date.now() - startedAt,
    errorCode: null,
    checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
  };
}

async function runBitrefillReadV1(input: ReviewedPluginReadInputV1): Promise<BaseMcpConsoleResultV1> {
  const startedAt = Date.now();
  const checkedAt = reviewedBaseMcpPluginRuntimeV1.now().toISOString();
  const extraction = extractCommerceIntentV1(input.message);
  if (!extraction.query || !extraction.country) {
    return {
      status: 'answered',
      reply: 'Specify a Bitrefill product and country, for example “Find a 20 USD Steam US gift card on Bitrefill.” No catalogue request was sent.',
      trace: [], toolsAvailable: 1, truncated: false, elapsedMs: Date.now() - startedAt,
      errorCode: null, checkedAt,
    };
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

export async function runReviewedBaseMcpPluginReadV1(
  input: ReviewedPluginReadInputV1,
): Promise<BaseMcpConsoleResultV1 | null> {
  if (input.providerId === 'virtuals') return runVirtualsReadV1(input);
  if (input.providerId === 'venice' && input.exampleId === 'models') {
    return runSimpleReviewedReadV1({
      namespace: 'venice',
      calls: [{ tool: 'venice_get_models', path: '/api/v1/models?type=all', timeoutMs: 7_000, args: { type: 'all' } }],
      reply: (results) => veniceModelsReplyV1(results[0]?.data),
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
      reply: (results) => address ? bankrLaunchReplyV1(results[0]?.data) : bankrLaunchesReplyV1(results[0]?.data),
    });
  }
  if (input.providerId === 'balancer' && input.exampleId === 'yield') {
    const query = `query Pools($first: Int, $orderBy: GqlPoolOrderBy, $orderDirection: GqlPoolOrderDirection, $where: GqlPoolFilter) { poolGetPools(first: $first, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) { id address chain type name symbol protocolVersion dynamicData { totalLiquidity volume24h aprItems { apr type } } poolTokens { address symbol weight } } }`;
    return runSimpleReviewedReadV1({
      namespace: 'balancer',
      calls: [{
        tool: 'balancer_get_pools', path: '/', method: 'POST', timeoutMs: 7_000,
        body: { query, variables: { first: 25, orderBy: 'apr', orderDirection: 'desc', where: { chainIn: ['BASE'], minTvl: 100_000 } } },
        args: { chain: 'BASE', first: 25, orderBy: 'apr', minTvl: 100_000, assetFilter: 'ETH' },
      }],
      reply: (results) => balancerPoolsReplyV1(results[0]?.data),
    });
  }
  if (input.providerId === 'bitrefill' && ['browse', 'search'].includes(input.exampleId ?? '')) {
    return runBitrefillReadV1(input);
  }
  if (input.providerId !== 'moonwell') return null;
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
          path: '/v1/markets/USDC?chain=base',
          args: { chain: 'base', asset: 'USDC' },
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
      : moonwellMarketsReplyV1(called.results[0]?.data, 'USDC'),
    trace,
    toolsAvailable: calls.length,
    truncated: false,
    elapsedMs: Date.now() - startedAt,
    errorCode: null,
    checkedAt: reviewedBaseMcpPluginRuntimeV1.now().toISOString(),
  };
}
