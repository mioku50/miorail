import { InMemoryStillLoopRepositoryV1 } from '../src/stillLoops.js';
import { stillLoopsContractV1 } from './stillLoops.contract.js';

stillLoopsContractV1('memory', async () => new InMemoryStillLoopRepositoryV1());
