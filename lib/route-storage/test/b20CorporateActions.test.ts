import { createMemoryB20CorporateActionRepository } from '../src/b20CorporateActionsMemory.js';
import { b20CorporateActionContractV1 } from './b20CorporateActions.contract.js';

b20CorporateActionContractV1('memory', async () => ({
  repository: createMemoryB20CorporateActionRepository(),
}));
