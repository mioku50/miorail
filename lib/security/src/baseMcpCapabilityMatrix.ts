import { BASE_MCP_PLUGIN_CATALOGUE_V1 } from './baseMcpPluginCatalogue.generated.js';
import {
  BASE_MCP_PROVIDER_INTENTS_V1,
  type BaseMcpProviderExampleV1,
  type BaseMcpProviderIntentSpecV1,
} from './baseMcpProviderIntents.js';

// ---------------------------------------------------------------------------
// What each Base plugin can actually do HERE, right now.
//
// The invariant this file exists to hold:
//
//   Nothing may be called `released` unless the current production runtime can
//   carry that exact intent to its honest end point.
//
// That is not what the registry used to say. `handoff_to_routes` meant "a
// quote adapter exists for this provider", and a quote adapter is the FIRST
// step of a swap, not the last one. Aerodrome and Balancer both had one, so
// both were routed into Routes AI, where the user reached a Review screen, the
// Safety Kernel refused for want of a simulation nobody could run, and the
// journey ended in a dead end that the Extensions card had advertised as
// working. The capability was released; the path was not.
//
// So a capability here is a pair — the operation AND the state — computed
// from a RUNTIME snapshot rather than declared. A deployment with no batch
// simulator gets a matrix that says so, in the console, in the catalogue and
// in the router, from one function. Turning the simulator on changes all three
// with no code edit; leaving it off can never make a dead end look alive.
// ---------------------------------------------------------------------------

/** The seven things a provider can be asked to do. */
export type BaseMcpCapabilityOperationV1 =
  | 'read'
  | 'quote'
  | 'prepare'
  | 'simulate'
  | 'action'
  | 'provider_ui'
  | 'routes';

/**
 * The five states an operation can be in. Distinct on purpose:
 *
 *   released       — the runtime carries this intent end to end today.
 *   unavailable    — Miorail could do this, and this deployment cannot right
 *                    now (a provider is down, a simulator is unconfigured).
 *   requires_input — capable, but the user has not named a required field.
 *   external_ui    — it completes in the provider's own interface, by design.
 *   unsupported    — no path exists here at all.
 */
export type BaseMcpCapabilityStateV1 =
  | 'released'
  | 'unavailable'
  | 'requires_input'
  | 'external_ui'
  | 'unsupported';

export interface BaseMcpCapabilityCellV1 {
  operation: BaseMcpCapabilityOperationV1;
  state: BaseMcpCapabilityStateV1;
  /** Why, in one clause. Shown to the user; never a stack trace. */
  reason: string;
}

export interface BaseMcpPluginCapabilityRowV1 {
  pluginId: string;
  productSurface: 'routes' | 'extensions';
  lifecycleStage: BaseMcpProviderIntentSpecV1['lifecycleStage'];
  cells: Readonly<Record<BaseMcpCapabilityOperationV1, BaseMcpCapabilityCellV1>>;
}

/**
 * What the deployment can actually do, read once and passed in.
 *
 * Every field is a runtime fact, not a policy. The matrix is a pure function
 * of this snapshot, so the same code answers for production, for a test and
 * for the acceptance probe.
 */
export interface BaseMcpRuntimeSnapshotV1 {
  /** Plugin ids with a reviewed, code-owned HTTP read recipe in this build. */
  reviewedReadPlugins: readonly string[];
  /** Providers whose swap/earn route adapter is released in Routes AI. */
  releasedRouteProviders: readonly string[];
  /** Providers whose calldata Miorail refuses to sign without an executed
   * simulation. Their Routes handoff needs `batchSimulationAvailable` too. */
  simulationRequiredProviders: readonly string[];
  /** A simulator that executes ONE call against live state is configured. */
  singleCallSimulationAvailable: boolean;
  /** A simulator that executes an ORDERED BATCH against one evolving state is
   * configured. Without it, any approve-then-swap route is unsignable. */
  batchSimulationAvailable: boolean;
  /** Plugin ids with a released typed action adapter in Extensions. */
  releasedActionPlugins: readonly string[];
  /** Plugin ids whose write path deliberately completes in the provider's UI. */
  providerUiPlugins: readonly string[];
  /** Plugin ids whose write path needs a typed x402 prepare Miorail has not
   * built. Recognised, refused, and told apart from `unsupported`. */
  typedX402Plugins: readonly string[];
}

/**
 * Whether a provider's ROUTE is genuinely end to end.
 *
 * Two conditions, and the second one is the whole point of this module. A
 * route adapter that produces calldata Miorail then refuses to sign is not a
 * released capability; it is a longer way to reach the same refusal.
 *
 * The simulator question is about call SHAPE, not about the provider. A native
 * ETH swap is one call and a single-call simulator proves it. An ERC-20 swap
 * carries approve+swap and needs a batch simulator, because proving the swap
 * against state where the approval has not happened proves nothing.
 */
export function providerRouteCapabilityV1(
  pluginId: string,
  runtime: BaseMcpRuntimeSnapshotV1,
): BaseMcpCapabilityCellV1 {
  if (!runtime.releasedRouteProviders.includes(pluginId)) {
    return {
      operation: 'routes',
      state: 'unsupported',
      reason: 'No released Routes AI adapter compares or builds this provider.',
    };
  }
  if (!runtime.simulationRequiredProviders.includes(pluginId)) {
    return {
      operation: 'routes',
      state: 'released',
      reason: 'Partner-built calldata: compared in Routes AI and signable without a fork simulation.',
    };
  }
  if (runtime.batchSimulationAvailable) {
    return {
      operation: 'routes',
      state: 'released',
      reason: 'Server-written calldata, and a batch simulator is configured to prove it before signing.',
    };
  }
  if (runtime.singleCallSimulationAvailable) {
    return {
      operation: 'routes',
      state: 'unavailable',
      reason: 'Server-written calldata needs a simulation before signing. Only a single-call simulator is configured here, so a swap that needs an approval first cannot be proven and will not be signed.',
    };
  }
  return {
    operation: 'routes',
    state: 'unavailable',
    reason: 'Server-written calldata needs a simulation before signing, and no simulation provider is configured on this deployment.',
  };
}

function readCapabilityV1(
  plugin: BaseMcpProviderIntentSpecV1,
  runtime: BaseMcpRuntimeSnapshotV1,
): BaseMcpCapabilityCellV1 {
  const declaresRead = plugin.examples.some((example) => example.surface === 'read');
  if (!declaresRead) {
    return { operation: 'read', state: 'unsupported', reason: 'This plugin declares no read in its Base spec.' };
  }
  if (runtime.reviewedReadPlugins.includes(plugin.pluginId)) {
    return { operation: 'read', state: 'released', reason: 'A reviewed, host-pinned HTTP read runs here.' };
  }
  return {
    operation: 'read',
    state: 'unavailable',
    reason: 'Base publishes a read for this plugin, and Miorail has no reviewed recipe for it yet, so nothing is called.',
  };
}

function actionCapabilityV1(
  plugin: BaseMcpProviderIntentSpecV1,
  runtime: BaseMcpRuntimeSnapshotV1,
): BaseMcpCapabilityCellV1 {
  const declaresAction = plugin.examples.some((example) => example.surface === 'action');
  if (!declaresAction) {
    return { operation: 'action', state: 'unsupported', reason: 'This plugin declares no direct action in its Base spec.' };
  }
  if (runtime.releasedActionPlugins.includes(plugin.pluginId)) {
    return {
      operation: 'action',
      state: 'released',
      reason: 'A typed action adapter runs here and every write is approved in your Base Account.',
    };
  }
  if (runtime.providerUiPlugins.includes(plugin.pluginId)) {
    return {
      operation: 'action',
      state: 'external_ui',
      reason: 'This write completes in the provider’s own interface, by design.',
    };
  }
  if (runtime.typedX402Plugins.includes(plugin.pluginId)) {
    return {
      operation: 'action',
      state: 'requires_input',
      reason: 'This provider quotes its own x402 payment terms during prepare. Miorail asks for the fields it needs rather than substituting a generic URL.',
    };
  }
  return {
    operation: 'action',
    state: 'unsupported',
    reason: 'No typed action adapter exists for this write, so no write tool is called.',
  };
}

/** The full row for one plugin. */
export function pluginCapabilityRowV1(
  plugin: BaseMcpProviderIntentSpecV1,
  runtime: BaseMcpRuntimeSnapshotV1,
): BaseMcpPluginCapabilityRowV1 {
  const read = readCapabilityV1(plugin, runtime);
  const routes = providerRouteCapabilityV1(plugin.pluginId, runtime);
  const action = actionCapabilityV1(plugin, runtime);
  const routable = plugin.examples.some((example) => example.surface === 'routable');

  // A quote is the first half of a route, and it is genuinely released on its
  // own: comparison works even where signing does not. Saying so is the honest
  // version of the old conflation — it just no longer implies the handoff.
  const quote: BaseMcpCapabilityCellV1 = routable && runtime.releasedRouteProviders.includes(plugin.pluginId)
    ? { operation: 'quote', state: 'released', reason: 'This provider is quoted and compared in Routes AI.' }
    : { operation: 'quote', state: 'unsupported', reason: 'No released quote adapter compares this provider.' };

  const prepare: BaseMcpCapabilityCellV1 = routes.state === 'released'
    ? { operation: 'prepare', state: 'released', reason: 'Routes AI builds the unsigned calls for this provider.' }
    : quote.state === 'released'
      ? {
          operation: 'prepare',
          state: 'unavailable',
          reason: `Calls can be built but not proven here — ${routes.reason}`,
        }
      : { operation: 'prepare', state: 'unsupported', reason: 'No released builder produces calldata for this provider.' };

  const requiresSimulation = runtime.simulationRequiredProviders.includes(plugin.pluginId);
  const simulate: BaseMcpCapabilityCellV1 = !routable
    ? { operation: 'simulate', state: 'unsupported', reason: 'Nothing routable to simulate.' }
    : !requiresSimulation
      ? {
          operation: 'simulate',
          state: runtime.singleCallSimulationAvailable || runtime.batchSimulationAvailable ? 'released' : 'unavailable',
          reason: runtime.singleCallSimulationAvailable || runtime.batchSimulationAvailable
            ? 'A simulator is configured; partner-built calldata is signable with or without it.'
            : 'No simulation provider is configured. Partner-built calldata is still signable on static checks alone.',
        }
      : runtime.batchSimulationAvailable
        ? { operation: 'simulate', state: 'released', reason: 'A batch simulator executes these calls against one evolving state.' }
        : {
            operation: 'simulate',
            state: 'unavailable',
            reason: runtime.singleCallSimulationAvailable
              ? 'Only a single-call simulator is configured, so an approve-then-swap batch cannot be executed as one.'
              : 'No simulation provider is configured on this deployment.',
          };

  const providerUi: BaseMcpCapabilityCellV1 = runtime.providerUiPlugins.includes(plugin.pluginId)
    ? { operation: 'provider_ui', state: 'external_ui', reason: 'Miorail hands off to the provider’s own interface and opens no position itself.' }
    : { operation: 'provider_ui', state: 'unsupported', reason: 'This plugin has no provider-UI handoff here.' };

  return {
    pluginId: plugin.pluginId,
    productSurface: plugin.productSurface,
    lifecycleStage: plugin.lifecycleStage,
    cells: Object.freeze({ read, quote, prepare, simulate, action, provider_ui: providerUi, routes }),
  };
}

/** Every published plugin, in catalogue order. */
export function baseMcpCapabilityMatrixV1(
  runtime: BaseMcpRuntimeSnapshotV1,
): readonly BaseMcpPluginCapabilityRowV1[] {
  const byId = new Map(BASE_MCP_PROVIDER_INTENTS_V1.map((entry) => [entry.pluginId, entry]));
  return BASE_MCP_PLUGIN_CATALOGUE_V1.flatMap((spec) => {
    const intent = byId.get(spec.id);
    return intent ? [pluginCapabilityRowV1(intent, runtime)] : [];
  });
}

/**
 * The gate the router asks before sending a provider-named intent into Routes
 * AI. One quote adapter is not enough — see the header.
 */
export function mayHandOffToRoutesV1(pluginId: string, runtime: BaseMcpRuntimeSnapshotV1): boolean {
  return providerRouteCapabilityV1(pluginId, runtime).state === 'released';
}

/**
 * What an example prompt resolves to once the runtime is taken into account.
 *
 * The registry's declared disposition is the INTENT; this is what actually
 * happens. They differ exactly where the runtime cannot keep the promise, and
 * that difference is the thing the console must show rather than hide.
 */
export function exampleCapabilityStateV1(
  plugin: BaseMcpProviderIntentSpecV1,
  example: BaseMcpProviderExampleV1,
  runtime: BaseMcpRuntimeSnapshotV1,
): BaseMcpCapabilityCellV1 {
  const row = pluginCapabilityRowV1(plugin, runtime);
  switch (example.disposition) {
    case 'read_in_extensions':
      return row.cells.read;
    case 'handoff_to_routes':
      return row.cells.routes;
    case 'handoff_to_provider_ui':
      return row.cells.provider_ui;
    case 'action_in_extensions':
      return row.cells.action;
    case 'typed_x402_required':
      return {
        operation: 'action',
        state: 'requires_input',
        reason: 'This provider quotes its own payment terms. Miorail asks for the exact fields it needs.',
      };
    case 'route_unavailable_here':
      return row.cells.routes;
    case 'adapter_required':
    default:
      return {
        operation: 'action',
        state: 'unsupported',
        reason: 'No typed adapter exists for this operation, so nothing is called.',
      };
  }
}
