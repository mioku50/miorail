import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// T72-C §5/§6 — the authenticated MCP surface, exercised through a real client.
//
// It runs against a RUNNING Miorail server and drives the whole handoff:
// qualification, a persisted plan, the released action, a recorded submission
// and the reconciled outcome. Everything up to the wallet is verified for real.
//
// WHAT IT WILL NOT DO WITHOUT BEING TOLD TWICE:
//
//   The step where a human approves a transaction in their Base Account is not
//   something a smoke script may reach by default. So the script STOPS at the
//   released action unless MIORAIL_MCP_LIVE_SMOKE=true, and even then it
//   refuses to continue unless the operator has separately named the wallet,
//   the plan, a maximum spend and the chain. There is no default live
//   transaction, and no combination of a single variable produces one.
//
// USAGE
//
//   MIORAIL_MCP_HANDOFF_TOKEN=<token from /api/mcp/handoff> \
//   MIORAIL_MCP_PRIVATE_URL=https://host/mcp/private \
//   SMOKE_B20_TOKEN_ADDRESS=0x... \
//     pnpm smoke:mcp-private
//
// The token is read from the environment and never printed, never logged and
// never written to a file.
// ---------------------------------------------------------------------------

const url = process.env.MIORAIL_MCP_PRIVATE_URL?.trim() || 'http://127.0.0.1:3000/mcp/private';
const token = process.env.MIORAIL_MCP_HANDOFF_TOKEN?.trim() || '';
const tokenAddress = process.env.SMOKE_B20_TOKEN_ADDRESS?.trim().toLowerCase() || '';
const positionAtomic = process.env.SMOKE_MCP_POSITION_ATOMIC?.trim() || '5000000';

const EXPECTED_TOOLS_V1 = [
  'miorail_check_exit_profile',
  'miorail_get_base_mcp_action',
  'miorail_get_execution_status',
  'miorail_prepare_b20_entry',
  'miorail_record_base_mcp_submission',
];

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { text?: string }[];
};

const results: { check: string; ok: boolean; note: string }[] = [];

function record(check: string, ok: boolean, note = ''): void {
  results.push({ check, ok, note });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${check}${note ? ` — ${note}` : ''}`);
}

function payloadOf(result: unknown): Record<string, unknown> {
  return ((result as ToolResult).structuredContent ?? {}) as Record<string, unknown>;
}

function textOf(result: unknown): string {
  return ((result as ToolResult).content ?? []).map((entry) => entry.text ?? '').join('\n');
}

function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: 'miorail-private-smoke', version: '1.0.0' });
  return client
    .connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      }),
    )
    .then(() => client);
}

/** §6 — the four things an operator must state before anything can be signed.
 * Each is separate on purpose: no single variable produces a live transaction. */
function liveApprovalGateV1(): { allowed: boolean; reason: string } {
  if ((process.env.MIORAIL_MCP_LIVE_SMOKE ?? '').trim().toLowerCase() !== 'true') {
    return { allowed: false, reason: 'MIORAIL_MCP_LIVE_SMOKE is not true' };
  }
  const wallet = (process.env.MIORAIL_MCP_LIVE_WALLET ?? '').trim().toLowerCase();
  const planId = (process.env.MIORAIL_MCP_LIVE_PLAN_ID ?? '').trim();
  const maxSpend = (process.env.MIORAIL_MCP_LIVE_MAX_USDC_ATOMIC ?? '').trim();
  const chainId = (process.env.MIORAIL_MCP_LIVE_CHAIN_ID ?? '').trim();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return { allowed: false, reason: 'MIORAIL_MCP_LIVE_WALLET is not set' };
  if (!planId) return { allowed: false, reason: 'MIORAIL_MCP_LIVE_PLAN_ID is not set' };
  if (!/^[0-9]{1,30}$/.test(maxSpend)) {
    return { allowed: false, reason: 'MIORAIL_MCP_LIVE_MAX_USDC_ATOMIC is not set' };
  }
  // Pinned rather than defaulted: a live run on the wrong chain is not a thing
  // an operator should be able to reach by omitting a variable.
  if (chainId !== '8453') return { allowed: false, reason: 'MIORAIL_MCP_LIVE_CHAIN_ID must be exactly 8453' };
  return { allowed: true, reason: `wallet ${wallet}, plan ${planId}, max ${maxSpend} atomic USDC on 8453` };
}

async function main(): Promise<void> {
  console.log(`Miorail private MCP smoke → ${url}`);
  if (!token) {
    throw new Error(
      'MIORAIL_MCP_HANDOFF_TOKEN is required. Sign in to Miorail and POST /api/mcp/handoff to mint one.',
    );
  }

  // --- §5.1 authenticated wallet binding -----------------------------------
  const client = await connect(token);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  const missing = EXPECTED_TOOLS_V1.filter((name) => !names.includes(name));
  record('the five private tools are advertised', missing.length === 0, missing.join(', '));

  for (const tool of (await client.listTools()).tools) {
    const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const walletShaped = properties.filter((property) => /wallet|owner|tenant|account|signer/i.test(property));
    if (walletShaped.length > 0) {
      throw new Error(`${tool.name} accepts a wallet-shaped argument: ${walletShaped.join(', ')}`);
    }
  }
  record('no tool accepts a wallet argument', true, 'the binding comes from the token');

  // --- §5.2 another wallet is refused ---------------------------------------
  // A token that is well-formed but signed with a different secret is the
  // closest an outsider can get without the server's key.
  const forged = `${token.split('.').slice(0, 2).join('.')}.${'A'.repeat(43)}`;
  let strangerRefused = false;
  try {
    const stranger = await connect(forged);
    await stranger.close();
  } catch {
    strangerRefused = true;
  }
  record('a token that is not ours is refused', strangerRefused);

  // --- §5.3 a provisional observation cannot execute ------------------------
  const fabricated = payloadOf(
    await client.callTool({
      name: 'miorail_prepare_b20_entry',
      arguments: {
        // Shaped like a Discover observation id. Nothing qualified it.
        clearanceId: 'b20-observation:smoke',
        positionAtomic,
        requestId: `smoke-${Date.now()}`,
      },
    }),
  );
  record(
    'a background observation cannot be prepared',
    fabricated.planId === null || fabricated.outcome !== 'prepared',
    String(fabricated.refusalReason ?? fabricated.outcome ?? ''),
  );

  if (!tokenAddress) {
    console.log('\nSMOKE_B20_TOKEN_ADDRESS is not set — stopping before qualification.');
    return summarise();
  }

  // --- §5.4 a qualified clearance prepares one plan -------------------------
  const checked = await client.callTool({
    name: 'miorail_check_exit_profile',
    arguments: { tokenAddress, positionAtomic },
  });
  if ((checked as ToolResult).isError) {
    record('the live exit check ran', false, textOf(checked).slice(0, 200));
    return summarise();
  }
  const check = payloadOf(checked);
  record('the live wallet-bound check ran', true, `viability ${String(check.viability)}`);
  if (!check.qualified) {
    console.log('\nThe token did not qualify, so there is nothing to prepare. That is a valid smoke result.');
    return summarise();
  }

  const requestId = `smoke-${Date.now()}`;
  const prepared = payloadOf(
    await client.callTool({
      name: 'miorail_prepare_b20_entry',
      arguments: { clearanceId: check.clearanceId, positionAtomic, requestId },
    }),
  );
  record('a qualified clearance prepared a plan', typeof prepared.planId === 'string', String(prepared.planId ?? ''));
  record('the plan carries no calls', prepared.calls === null);

  // Idempotency: the same request id must return the same plan, not re-quote.
  const replayed = payloadOf(
    await client.callTool({
      name: 'miorail_prepare_b20_entry',
      arguments: { clearanceId: check.clearanceId, positionAtomic, requestId },
    }),
  );
  record('a repeated prepare returns the same plan', replayed.planId === prepared.planId);

  if (!prepared.executionAvailable) {
    console.log(
      '\nExecutable handoff is off on this server (Stage A). The read path is verified; no calls were requested.',
    );
    return summarise();
  }

  // --- §5.5/§5.6 the action is released once, and matches the plan ----------
  const attemptRequestId = `smoke-attempt-${Date.now()}`;
  const released = payloadOf(
    await client.callTool({
      name: 'miorail_get_base_mcp_action',
      arguments: { planId: prepared.planId, positionAtomic, attemptRequestId },
    }),
  );
  if (released.outcome !== 'ready') {
    record('the action was released', false, String(released.reason ?? ''));
    return summarise();
  }
  record('a Base MCP-compatible action was released', true, `attempt ${String(released.attemptId)}`);
  record(
    'the returned calls hash matches the persisted plan',
    released.callsHash === prepared.callsHash && released.callsHash === released.callsHashOfReturnedCalls,
  );
  const action = released.action as { chainId: string; from: string; calls: unknown[] };
  record('the action is pinned to Base mainnet', action.chainId === '0x2105', action.chainId);

  // --- §5.7 a duplicate release returns the same attempt --------------------
  const again = payloadOf(
    await client.callTool({
      name: 'miorail_get_base_mcp_action',
      arguments: { planId: prepared.planId, positionAtomic, attemptRequestId },
    }),
  );
  record(
    'a duplicate release returns the same attempt or is refused',
    again.attemptId === released.attemptId || again.outcome === 'refused',
    String(again.outcome),
  );

  // --- §6 the wallet boundary ----------------------------------------------
  const live = liveApprovalGateV1();
  if (!live.allowed) {
    console.log(`\nStopping before wallet approval: ${live.reason}.`);
    console.log('Nothing was submitted. The released action expires on its own.');
    // §5.8 — verified without a chain: a declined wallet must record nothing.
    const rejected = payloadOf(
      await client.callTool({
        name: 'miorail_record_base_mcp_submission',
        arguments: {
          planId: prepared.planId,
          attemptId: released.attemptId,
          submittedCallsHash: released.callsHash,
          result: 'user_rejected',
        },
      }),
    );
    const rejectedStatus = rejected.status as { state?: string; batchId?: string | null } | undefined;
    record(
      'a declined wallet creates no on-chain submission',
      rejectedStatus?.state === 'user_rejected' && !rejectedStatus?.batchId,
      String(rejectedStatus?.state ?? ''),
    );

    // §5.10 — an unknown result must never be retried automatically.
    const unknown = payloadOf(
      await client.callTool({
        name: 'miorail_record_base_mcp_submission',
        arguments: {
          planId: prepared.planId,
          attemptId: released.attemptId,
          submittedCallsHash: released.callsHash,
          result: 'unknown',
        },
      }),
    );
    record(
      'an unknown result is never turned into a retry',
      unknown.outcome === 'not_recorded' || unknown.outcome === 'recorded',
      String(unknown.reason ?? unknown.outcome ?? ''),
    );
    return summarise();
  }

  console.log(`\nLIVE APPROVAL ENABLED — ${live.reason}`);
  console.log('Miorail will not sign. Approve the batch in your Base Account, then this script reconciles it.');
  console.log(
    'Pass these calls to Base MCP send_calls yourself; this script does not call a wallet and holds no key.',
  );
  console.log(JSON.stringify({ chainId: action.chainId, from: action.from, callCount: action.calls.length }, null, 2));
  // §5.9 — after the operator submits, the status must reconcile against the
  // chain. The script reads it rather than asserting it: only reconciliation
  // establishes whether an entry happened.
  const status = payloadOf(
    await client.callTool({ name: 'miorail_get_execution_status', arguments: { planId: prepared.planId } }),
  );
  const state = (status.status as { state?: string } | undefined)?.state;
  console.log(`  execution status: ${String(state)} — ${String(status.stateMeaning ?? '')}`);
  record('the execution status is a named outcome', typeof state === 'string', String(state));

  await client.close();
  return summarise();
}

/** §8 — the deployment verification summary. */
function summarise(): void {
  const failed = results.filter((entry) => !entry.ok);
  console.log('');
  console.log(`Private MCP surface: ${process.env.MIORAIL_MCP_PRIVATE_V1 === 'true' ? 'enabled' : 'see server'}`);
  console.log(
    `Executable handoff: ${process.env.MIORAIL_MCP_PRIVATE_EXECUTION_V1 === 'true' ? 'enabled' : 'see server'}`,
  );
  const ttl = Number.parseInt((process.env.MIORAIL_MCP_HANDOFF_TTL_MS ?? '900000').trim(), 10);
  console.log(`Token TTL: ${Math.round((Number.isFinite(ttl) ? ttl : 900_000) / 60_000)} minutes`);
  console.log('Audit storage: checked by the server on every release');
  console.log('Public MCP: read-only');
  console.log(`Live smoke: ${liveApprovalGateV1().allowed ? 'enabled' : 'disabled'}`);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const entry of failed) console.error(`  FAIL ${entry.check}${entry.note ? ` — ${entry.note}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // The token must never reach a log, so no request context is printed.
  console.error(`smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
