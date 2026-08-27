import { createMemoryRepresentationSupplyRepository } from '../src/representationSupplyMemory.js';
import { representationSupplyContractV1 } from './representationSupply.contract.js';

representationSupplyContractV1('memory', async () => ({
  repository: createMemoryRepresentationSupplyRepository(),
}));
