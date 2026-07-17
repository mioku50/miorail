import type { RouteStorageRepository } from '@mioagent/route-storage';
import { assembleExecutionBlueprintV1, classifySwapCallV1 } from '../src/blueprint.js';
import type { ApproveExecutionBlueprintInput } from '../src/approval.js';
import { NOW, TENANT, WALLET, buildScenario, defaultBuiltCalls, seedRepository, type FixtureScenario } from './fixtures.js';

export const T57_ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;
export const T57_BLUEPRINT_ID = 'blueprint-t57-approve-fixture';

export interface SeededBlueprint {
  scenario: FixtureScenario;
  repository: RouteStorageRepository;
  blueprint: ReturnType<typeof assembleExecutionBlueprintV1>;
}

export async function seededBlueprint(
  overrides: { createdAt?: Date; quoteExpiry?: string } = {},
): Promise<SeededBlueprint> {
  const scenario = buildScenario();
  const repository = await seedRepository(scenario);
  const calls = defaultBuiltCalls({ amountAtomic: scenario.intent.amount.amountAtomic }).map((call, index) =>
    classifySwapCallV1({
      index,
      call,
      routerAddress: T57_ROUTER,
      usdcAsset: scenario.intent.fromAsset!,
      walletAddress: WALLET,
    }),
  );
  const blueprint = assembleExecutionBlueprintV1({
    id: T57_BLUEPRINT_ID,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    now: overrides.createdAt ?? NOW,
    intentHash: scenario.intent.intentHash,
    selectedCandidateHash: scenario.uniswap.candidate.candidateHash,
    evidenceSetHash: scenario.uniswap.evidenceSet.evidenceSetHash,
    quoteExpiry: overrides.quoteExpiry ?? new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    calls,
    inputAsset: scenario.intent.fromAsset!,
    inputAmountAtomic: scenario.intent.amount.amountAtomic,
    outputAsset: scenario.intent.toAsset!,
    outputExpectedAtomic: '38000000000000000',
    outputMinimumAtomic: '37810000000000000',
    simulationState: {
      status: 'unavailable',
      observedAt: null,
      blockNumber: null,
      requestHash: null,
      responseHash: null,
      errorCode: 'no_simulation_provider',
    },
  });
  await repository.insertBlueprint(scenario.intent.id, blueprint);
  return { scenario, repository, blueprint };
}

export function approveInput(
  seeded: SeededBlueprint,
  overrides: Partial<ApproveExecutionBlueprintInput> = {},
): ApproveExecutionBlueprintInput {
  return {
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.scenario.intent.id,
    blueprintId: seeded.blueprint.id,
    blueprintHash: seeded.blueprint.blueprintHash,
    now: NOW,
    ...overrides,
  };
}
