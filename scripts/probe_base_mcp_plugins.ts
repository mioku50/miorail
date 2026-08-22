import {
  BASE_MCP_PLUGIN_CATALOGUE_V1,
  BASE_MCP_PROVIDER_INTENTS_BY_ID_V1,
  baseMcpCapabilityMatrixV1,
  exampleCapabilityStateV1,
  type BaseMcpCapabilityOperationV1,
} from '@mioagent/security';
import { classifyBaseMcpExtensionIntentV1 } from '../artifacts/api-server/lib/baseMcpExtensionActions.js';
import { matchBaseMcpProviderIntentV1 } from '../artifacts/api-server/lib/baseMcpProviderRouting.js';
import { baseMcpRuntimeSnapshotV1 } from '../artifacts/api-server/lib/baseMcpRuntimeSnapshot.js';
import { probeSimulationProviderHealthV1 } from '../artifacts/api-server/lib/swapSimulation.js';
import { runReviewedBaseMcpPluginReadV1 } from '../artifacts/api-server/lib/baseMcpReviewedPluginRuntime.js';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Production acceptance for the Base MCP plugin runtime.
//
// Unit fixtures prove that a reply builder handles the payload we imagined.
// They cannot prove that Venice's catalogue is 265 KB, that Clawnch answers on
// `www.` and 307s on the apex, or that a Balancer swap reaches a Review screen
// nobody can sign. Every one of those was true in production while the tests
// were green, so this probe calls the real endpoints on the real paths and
// records, per plugin:
//
//   intent · matched provider · selected surface · tool/endpoint actually
//   called · status · duration · final capability state
//
// It is read-only by construction. It reaches only reviewed READ recipes and
// the deterministic intent classifier; it opens no wallet, prepares no
// transaction, creates no invoice and pays nothing. Action and routable
// intents are CLASSIFIED, never executed — the classifier is a pure function,
// which is exactly why its verdict is worth printing.
//
// No endpoint, credential or header is printed.
// ---------------------------------------------------------------------------

const WALLET_V1 = '0x0000000000000000000000000000000000000001';

interface ProbeRowV1 {
  pluginId: string;
  intent: string;
  matchedProvider: string | null;
  surface: string;
  disposition: string;
  toolCalled: string | null;
  status: string;
  durationMs: number;
  capability: string;
  note: string;
}

function truncateV1(value: string, max = 160): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * One prompt, taken end to end.
 *
 * A read runs for real. Anything else stops at the classifier, which is the
 * honest boundary: the classifier's answer IS the product's answer for those
 * intents, and executing them would move money.
 */
async function probeOneV1(pluginId: string, prompt: string): Promise<ProbeRowV1> {
  const runtime = baseMcpRuntimeSnapshotV1();
  const spec = BASE_MCP_PROVIDER_INTENTS_BY_ID_V1[pluginId];
  const startedAt = Date.now();
  const match = matchBaseMcpProviderIntentV1(prompt);
  const decision = classifyBaseMcpExtensionIntentV1(prompt);
  const example = spec?.examples.find((entry) => entry.prompt === prompt);
  const capability = spec && example
    ? exampleCapabilityStateV1(spec, example, runtime)
    : null;

  const base: ProbeRowV1 = {
    pluginId,
    intent: prompt,
    matchedProvider: match?.pluginId ?? null,
    surface: example?.surface ?? 'inferred',
    disposition: match?.disposition ?? 'no_match',
    toolCalled: null,
    status: decision.kind,
    durationMs: Date.now() - startedAt,
    capability: capability ? `${capability.state}` : 'not_declared',
    note: decision.kind === 'needs_input' ? truncateV1(decision.reply) : '',
  };

  if (decision.kind !== 'read') return base;

  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: decision.providerId,
    exampleId: decision.exampleId,
    message: prompt,
    walletAddress: WALLET_V1,
  });
  const durationMs = Date.now() - startedAt;
  if (!result) {
    return {
      ...base,
      durationMs,
      status: 'no_reviewed_recipe',
      note: 'No reviewed read recipe matched; the generic Base MCP console would answer from whatever tools the server exposes.',
    };
  }
  return {
    ...base,
    durationMs,
    toolCalled: result.trace[0]?.tool ?? null,
    status: result.errorCode ? `${result.status}:${result.errorCode}` : result.status,
    note: truncateV1(result.reply ?? ''),
  };
}

const OPERATIONS_V1: readonly BaseMcpCapabilityOperationV1[] = [
  'read',
  'quote',
  'prepare',
  'simulate',
  'action',
  'provider_ui',
  'routes',
];

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  // The same boot probe the API server runs. Without it this script reports a
  // batch simulator from the presence of an API key, and a key whose account
  // is out of monthly capacity is not a capability — which is exactly the
  // state production was in when this probe was written.
  const health = await probeSimulationProviderHealthV1();
  const runtime = baseMcpRuntimeSnapshotV1();

  console.log('=== Runtime snapshot ===');
  console.log(`single-call simulation : ${runtime.singleCallSimulationAvailable}`);
  console.log(`batch simulation       : ${runtime.batchSimulationAvailable}${health.batchProven === false ? ` (demoted: ${health.lastErrorCode})` : ''}`);
  console.log(`reviewed reads         : ${runtime.reviewedReadPlugins.join(', ')}`);
  console.log('');

  const rows: ProbeRowV1[] = [];
  for (const spec of BASE_MCP_PLUGIN_CATALOGUE_V1) {
    const intent = BASE_MCP_PROVIDER_INTENTS_BY_ID_V1[spec.id];
    if (!intent) continue;
    for (const example of intent.examples) {
      rows.push(await probeOneV1(spec.id, example.prompt));
    }
  }

  console.log('=== Per-intent probe ===');
  for (const row of rows) {
    console.log(
      [
        row.pluginId.padEnd(12),
        row.surface.padEnd(9),
        row.disposition.padEnd(22),
        row.capability.padEnd(15),
        (row.toolCalled ?? '—').padEnd(26),
        row.status.padEnd(30),
        `${row.durationMs}ms`,
      ].join(' '),
    );
    console.log(`             intent: ${row.intent}`);
    if (row.note) console.log(`             answer: ${row.note}`);
  }

  console.log('');
  console.log('=== Capability matrix ===');
  console.log(['plugin'.padEnd(12), ...OPERATIONS_V1.map((op) => op.padEnd(15))].join(' '));
  for (const row of baseMcpCapabilityMatrixV1(runtime)) {
    console.log([
      row.pluginId.padEnd(12),
      ...OPERATIONS_V1.map((op) => row.cells[op].state.padEnd(15)),
    ].join(' '));
  }

  console.log('');
  console.log('=== Reasons, where a capability is not released ===');
  for (const row of baseMcpCapabilityMatrixV1(runtime)) {
    for (const op of OPERATIONS_V1) {
      const cell = row.cells[op];
      if (cell.state === 'released' || cell.state === 'unsupported') continue;
      console.log(`${row.pluginId} · ${op} · ${cell.state}: ${cell.reason}`);
    }
  }
}

main().catch((error) => {
  console.error('probe failed', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
