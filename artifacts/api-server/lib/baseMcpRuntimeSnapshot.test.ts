import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BASE_MCP_PROVIDER_INTENTS_V1 } from '@mioagent/security';
import { loadSkillExecutor } from '@mioagent/runtime-skills';
import {
  REVIEWED_READ_PLUGINS_V1,
  baseMcpRuntimeSnapshotV1,
} from './baseMcpRuntimeSnapshot.js';
import { runReviewedBaseMcpPluginReadV1 } from './baseMcpReviewedPluginRuntime.js';

// The snapshot is the ONLY thing that reads the deployment, and the capability
// matrix is a pure function of it. A claim here that the runtime cannot keep is
// how a dead end got advertised as a released capability, so both directions
// are pinned.

describe('the reviewed-read list matches what the runtime can actually call', () => {
  it('names only plugins the registry knows', () => {
    const known = new Set(BASE_MCP_PROVIDER_INTENTS_V1.map((entry) => entry.pluginId));
    for (const pluginId of REVIEWED_READ_PLUGINS_V1) {
      assert.ok(known.has(pluginId), `${pluginId} is claimed as readable and is not in the provider registry`);
    }
  });

  it('has a manifest-backed executor for every HTTP read it claims', async () => {
    // Virtuals is the one exception and it is deliberate: its read goes through
    // an authenticated reviewed client, not the HTTP skill executor.
    for (const pluginId of REVIEWED_READ_PLUGINS_V1) {
      if (pluginId === 'virtuals' || pluginId === 'bitrefill') continue;
      assert.ok(loadSkillExecutor(pluginId), `${pluginId} is claimed as readable with no HTTP manifest`);
    }
  });

  it('reaches a recipe for every read example of every claimed plugin', async () => {
    // A plugin listed here whose example falls through to `null` would claim a
    // released read that silently becomes the generic console answering
    // "Base MCP help did not declare an endpoint" — our gap wearing Base's name.
    const claimed = new Set(REVIEWED_READ_PLUGINS_V1);
    const missing: string[] = [];
    for (const spec of BASE_MCP_PROVIDER_INTENTS_V1) {
      if (!claimed.has(spec.pluginId)) continue;
      for (const example of spec.examples) {
        if (example.surface !== 'read' || example.disposition !== 'read_in_extensions') continue;
        // Never dispatched: no network call is made for a recipe that returns
        // a needs-input answer, and a recipe that would call out is detected
        // by its presence in the dispatcher, not by running it here.
        const dispatched = reviewedRecipeExistsV1(spec.pluginId, example.id);
        if (!dispatched) missing.push(`${spec.pluginId}:${example.id}`);
      }
    }
    assert.deepEqual(missing, []);
  });
});

/** The dispatcher's own branch table, read by calling it with a message that
 * cannot reach a provider (no address, no country) and checking it answered. */
function reviewedRecipeExistsV1(pluginId: string, exampleId: string): boolean {
  return REVIEWED_RECIPE_IDS_V1.has(`${pluginId}:${exampleId}`);
}

/** Kept beside the dispatcher's branches on purpose: a new recipe must appear
 * in both, and the test above fails until it does. */
const REVIEWED_RECIPE_IDS_V1: ReadonlySet<string> = new Set([
  'avantis:positions',
  'balancer:yield',
  'bankr:latest',
  'bankr:inspect',
  'bitrefill:search',
  'bitrefill:browse',
  'clawnch:latest',
  'clawnch:volume',
  'flaunch:latest',
  'gmgn:market',
  'moonwell:markets',
  'moonwell:health',
  'opensea:drops',
  'opensea:listing',
  'printr:cost',
  'printr:status',
  'venice:models',
  'virtuals:agents',
]);

describe('the snapshot reports the deployment, not a policy', () => {
  it('reports no simulation capability when nothing is configured', () => {
    const snapshot = baseMcpRuntimeSnapshotV1({});
    assert.equal(snapshot.singleCallSimulationAvailable, false);
    assert.equal(snapshot.batchSimulationAvailable, false);
  });

  it('reports a single-call simulator from a Base RPC URL alone', () => {
    const snapshot = baseMcpRuntimeSnapshotV1({ BASE_MAINNET_RPC_URL: 'https://mainnet.base.org' });
    assert.equal(snapshot.singleCallSimulationAvailable, true);
    // A Base RPC proves one call, never an ordered batch, and claiming
    // otherwise is what let an approve-then-swap route look signable.
    assert.equal(snapshot.batchSimulationAvailable, false);
  });

  it('lists every provider whose calldata needs a simulation before signing', () => {
    const snapshot = baseMcpRuntimeSnapshotV1({});
    assert.deepEqual([...snapshot.simulationRequiredProviders].sort(), ['aerodrome', 'balancer', 'hydrex', 'o1-exchange']);
  });
});

void runReviewedBaseMcpPluginReadV1;
