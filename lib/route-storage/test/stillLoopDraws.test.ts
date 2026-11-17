import { InMemoryStillLoopDrawRepositoryV1 } from '../src/stillLoopDraws.js';
import { stillLoopDrawsContractV1 } from './stillLoopDraws.contract.js';

stillLoopDrawsContractV1('memory', async () => new InMemoryStillLoopDrawRepositoryV1());
