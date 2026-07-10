import {
  AutonomousExecutionGateway,
  createDatabaseAutonomyPolicyRepository,
  type AutonomyPolicyRepository,
} from '@mioagent/autonomy';
import { client } from '@mioagent/db';

let repository: AutonomyPolicyRepository = createDatabaseAutonomyPolicyRepository(client);

export function getAutonomyPolicyRepository(): AutonomyPolicyRepository {
  return repository;
}

export function getAutonomousExecutionGateway(): AutonomousExecutionGateway {
  return new AutonomousExecutionGateway({
    repository,
    mainnetExecutionEnabled: () => process.env.MAINNET_EXECUTION_ENABLED === 'true',
  });
}

export function setAutonomyPolicyRepositoryForTests(next: AutonomyPolicyRepository): void {
  repository = next;
}
