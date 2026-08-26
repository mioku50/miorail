import { createMemoryIssuerRepresentationRepository } from '../src/issuerRepresentationMemory.js';
import { issuerRepresentationContractV1 } from './issuerRepresentation.contract.js';

issuerRepresentationContractV1('memory', async () => ({
  repository: createMemoryIssuerRepresentationRepository(),
}));
