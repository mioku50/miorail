import type { BaseMcpRuntimeSnapshotV1 } from '@mioagent/security';
import { PROVIDERS_REQUIRING_SIMULATION_V1 } from '@mioagent/transaction-composer';
import { swapSimulationCapabilityV1 } from './swapSimulation.js';

// ---------------------------------------------------------------------------
// What this deployment can actually do, read once per request.
//
// The capability matrix is a pure function; this is the only place that reads
// the world it is a function OF. Keeping the two apart is what makes the same
// answer reachable from the router, the console card and the acceptance probe
// without three of them drifting into three different opinions.
//
// Everything here is derived from something that already existed and was
// consulted in the wrong place, or not at all:
//
//   * The reviewed read list was implicit in a chain of `if` statements inside
//     baseMcpReviewedPluginRuntime; a plugin with no branch simply fell through
//     to the generic console, which answered "Base MCP help did not declare a
//     Clawnch endpoint" — a sentence about Base for a gap that was ours.
//   * The simulation capability was never consulted outside the composer, so
//     the registry could call a Routes handoff released on a deployment that
//     could not sign it.
// ---------------------------------------------------------------------------

/**
 * Plugins with a reviewed, code-owned HTTP read recipe in this build.
 *
 * Exported and asserted against the dispatcher in a test: an entry here with
 * no branch in `runReviewedBaseMcpPluginReadV1` would claim a released read
 * that silently falls through to the generic console.
 */
export const REVIEWED_READ_PLUGINS_V1: readonly string[] = [
  'avantis',
  'bankr',
  'balancer',
  'bitrefill',
  'clawnch',
  'flaunch',
  'gmgn',
  'moonwell',
  'opensea',
  'printr',
  'venice',
  'virtuals',
];

/** Plugins with a released typed ACTION adapter in Extensions. */
export const RELEASED_ACTION_PLUGINS_V1: readonly string[] = ['virtuals'];

/** Plugins whose write path completes in the provider's own interface. */
export const PROVIDER_UI_PLUGINS_V1: readonly string[] = ['avantis'];

/** Plugins that quote their own x402 payment terms during prepare. */
export const TYPED_X402_PLUGINS_V1: readonly string[] = ['brickken', 'venice'];

/** Providers with a released Routes adapter in any family. Imported lazily to
 * avoid a cycle with baseMcpProviderRouting, which consults this snapshot. */
const ROUTE_ADAPTER_PROVIDERS_V1: readonly string[] = [
  'uniswap',
  'kyberswap',
  'aerodrome',
  'o1-exchange',
  'hydrex',
  'balancer',
  'moonwell',
  'morpho',
  'yo',
  'bitrefill',
  'opensea',
];

/**
 * Read the deployment. Cheap and side-effect free — `swapSimulationCapabilityV1`
 * constructs providers only to see whether they can be constructed and issues
 * no network call — so callers need no cache and tests need no clock.
 */
export function baseMcpRuntimeSnapshotV1(
  env: NodeJS.ProcessEnv = process.env,
): BaseMcpRuntimeSnapshotV1 {
  const simulation = swapSimulationCapabilityV1(env);
  return {
    reviewedReadPlugins: REVIEWED_READ_PLUGINS_V1,
    releasedRouteProviders: ROUTE_ADAPTER_PROVIDERS_V1,
    simulationRequiredProviders: PROVIDERS_REQUIRING_SIMULATION_V1,
    singleCallSimulationAvailable: simulation.singleCall,
    batchSimulationAvailable: simulation.batch,
    releasedActionPlugins: RELEASED_ACTION_PLUGINS_V1,
    providerUiPlugins: PROVIDER_UI_PLUGINS_V1,
    typedX402Plugins: TYPED_X402_PLUGINS_V1,
  };
}
