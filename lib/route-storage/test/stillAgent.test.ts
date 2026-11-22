import { createMemoryStillAgentRepositoryV1 } from '../src/stillAgentMemory.js';
import { stillAgentContractV1 } from './stillAgent.contract.js';

stillAgentContractV1('memory', async () => createMemoryStillAgentRepositoryV1());
