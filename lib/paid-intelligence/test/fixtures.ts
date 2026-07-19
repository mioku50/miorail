import {
  ExecutionBlueprintV1Schema,
  hashExecutionBlueprintV1,
  ZERO_HASH_V1,
  type ExecutionBlueprintV1,
  type MoneyV1,
  type ProviderRefV1,
} from '@mioagent/route-domain';
import {
  FIXTURE_TENANT,
  FIXTURE_WALLET,
  USDC_BASE,
  missingSafetyEvidenceSetFixture,
  validBlueprintFixture,
  validSwapIntentFixture,
  validUniswapCandidateFixture,
} from '@mioagent/route-domain/fixtures';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';

export const TENANT_ID = FIXTURE_TENANT;
export const WALLET_ADDRESS = FIXTURE_WALLET as `0x${string}`;

export const SIMULATION_PRICE: MoneyV1 = {
  asset: USDC_BASE,
  amountAtomic: '10000',
  amountDecimal: '0.01',
  usdValue: '0.01',
};

export const SIMULATION_PROVIDER_REF: ProviderRefV1 = {
  id: 'generic-sim-v1',
  displayName: 'Generic Simulation Provider',
  kind: 'simulation',
  operator: 'fixture-operator',
};

// T59 fixture blueprint: points at missingSafetyEvidenceSetFixture (status
// 'partial', missingEvidence ['contract_risk','simulation']) instead of
// validBlueprintFixture's own completeEvidenceSetFixture, so tests can
// observe 'simulation' actually leaving missingEvidence after a paid run.
// simulationState honestly starts 'unavailable' (T56 prepare-flow honesty),
// not the pre-baked 'passed' on validBlueprintFixture.
const blueprintDraft: ExecutionBlueprintV1 = {
  ...validBlueprintFixture,
  id: 'blueprint-t59-fixture',
  evidenceSetHash: missingSafetyEvidenceSetFixture.evidenceSetHash,
  blueprintHash: ZERO_HASH_V1,
  simulationState: {
    status: 'unavailable',
    observedAt: null,
    blockNumber: null,
    requestHash: null,
    responseHash: null,
    errorCode: 'no_simulation_provider',
  },
};
export const T59_BLUEPRINT_FIXTURE = ExecutionBlueprintV1Schema.parse({
  ...blueprintDraft,
  blueprintHash: hashExecutionBlueprintV1(blueprintDraft),
});

export interface SeededPaidSimulationFixture {
  repository: InMemoryRouteStorageRepository;
  routeRunId: string;
  blueprintId: string;
}

export async function seedPaidSimulationFixture(): Promise<SeededPaidSimulationFixture> {
  const repository = new InMemoryRouteStorageRepository();
  await repository.createRouteRun(validSwapIntentFixture, 'idem-t59-fixture-run');
  await repository.insertCandidate(validSwapIntentFixture.id, validUniswapCandidateFixture);
  for (const record of missingSafetyEvidenceSetFixture.records) {
    await repository.insertEvidence(validSwapIntentFixture.id, validUniswapCandidateFixture.id, record);
  }
  await repository.insertEvidenceSet(
    validSwapIntentFixture.id,
    validUniswapCandidateFixture.id,
    missingSafetyEvidenceSetFixture,
  );
  await repository.insertBlueprint(validSwapIntentFixture.id, T59_BLUEPRINT_FIXTURE);
  return {
    repository,
    routeRunId: validSwapIntentFixture.id,
    blueprintId: T59_BLUEPRINT_FIXTURE.id,
  };
}
