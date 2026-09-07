import type { BaseMcpRuntimeSnapshotV1 } from '@mioagent/security';
import { resolvePluginCredential } from '@mioagent/security/httpAllowlist';
import { pluginExecutorAuthV1, publishedPluginCredentialV1 } from '@mioagent/runtime-skills';
import { reviewedReadsNeedingSignInV1 } from './baseMcpReadShapes.js';
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
/**
 * Which reviewed reads cannot authenticate here, and which run as the reader.
 *
 * Derived on every call, from three facts that are already true somewhere else:
 * Base's own `auth:` frontmatter in the catalogue, the credentials a plugin
 * spec PUBLISHES (GMGN's read key ships in Base's spec and is not a missing
 * key), and what `resolvePluginCredential` resolves in this process. Nothing
 * here is a list somebody has to remember to update when a key is rotated or
 * a second deployment runs without one.
 */
function readCredentialStateV1(reviewed: readonly string[]): {
  missing: string[];
  signIn: string[];
} {
  const signIn = reviewedReadsNeedingSignInV1().filter((id) => reviewed.includes(id));
  const missing: string[] = [];
  for (const id of reviewed) {
    if (signIn.includes(id)) continue;
    // The EXECUTOR's contract, not the plugin spec's label. A first pass read
    // `auth:` off Base's frontmatter and put "sign in first" on Venice's model
    // catalogue, which answers 200 to nobody in particular — the spec describes
    // a whole plugin, and the recipe is one call inside it.
    if (pluginExecutorAuthV1(id) !== 'api-key') continue;
    if (publishedPluginCredentialV1(id)) continue;
    if (!resolvePluginCredential(id)) missing.push(id);
  }
  return { missing, signIn };
}

export function baseMcpRuntimeSnapshotV1(
  env: NodeJS.ProcessEnv = process.env,
): BaseMcpRuntimeSnapshotV1 {
  const simulation = swapSimulationCapabilityV1(env);
  const credentials = readCredentialStateV1(REVIEWED_READ_PLUGINS_V1);
  return {
    readPluginsMissingCredential: credentials.missing,
    readPluginsNeedingSignIn: credentials.signIn,
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
