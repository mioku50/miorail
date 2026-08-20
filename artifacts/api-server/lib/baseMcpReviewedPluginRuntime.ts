import { loadSkillExecutor, type BaseMcpSkillExecutor } from '@mioagent/runtime-skills';
import type { BaseMcpConsoleResultV1 } from './baseMcpConsole.js';
import { baseMcpConsoleArgsV1, baseMcpConsoleResultTextV1 } from './baseMcpConsole.js';
import { sanitizedToolErrorCode } from './streamReadRouting.js';
import {
  PostgresBaseMcpPluginSessionStoreV1,
  type BaseMcpPluginSessionStoreV1,
} from './baseMcpPluginSessionStore.js';
import { callVirtualsReviewedV1 } from './virtualsReviewedClient.js';

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
    const supply = firstDisplayV1(row, ['supplyApy', 'supplyAPY', 'supplyApr', 'supplyAPR', 'supplyRate']);
    const borrow = firstDisplayV1(row, ['borrowApy', 'borrowAPY', 'borrowApr', 'borrowAPR', 'borrowRate']);
    const liquidity = firstDisplayV1(row, ['liquidity', 'availableLiquidity', 'cash']);
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
  calls: readonly { tool: string; path: string; args: Record<string, unknown> }[],
): Promise<{ results: { tool: string; args: Record<string, unknown>; data: unknown }[]; error: BaseMcpConsoleResultV1 | null }> {
  const startedAt = Date.now();
  const results: { tool: string; args: Record<string, unknown>; data: unknown }[] = [];
  for (const call of calls) {
    try {
      const response = await executor.request({ path: call.path, method: 'GET', chainId: 8453 });
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

export async function runReviewedBaseMcpPluginReadV1(
  input: ReviewedPluginReadInputV1,
): Promise<BaseMcpConsoleResultV1 | null> {
  if (input.providerId === 'virtuals') return runVirtualsReadV1(input);
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
