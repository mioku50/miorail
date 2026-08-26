import { createMemoryRepresentationRatioRepository } from '../src/representationRatioMemory.js';
import { representationRatioContractV1 } from './representationRatio.contract.js';

representationRatioContractV1('memory', async () => ({
  repository: createMemoryRepresentationRatioRepository(),
}));
