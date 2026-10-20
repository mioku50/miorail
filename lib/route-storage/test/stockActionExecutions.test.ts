import { InMemoryStockActionExecutionRepositoryV1 } from '../src/stockActionExecutions.js';
import { stockActionExecutionContract } from './stockActionExecutions.contract.js';

stockActionExecutionContract('memory', async () => new InMemoryStockActionExecutionRepositoryV1());
