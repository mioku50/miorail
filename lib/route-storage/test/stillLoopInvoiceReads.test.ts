import { InMemoryStillLoopInvoiceReadRepositoryV1 } from '../src/stillLoopInvoiceReads.js';
import { stillLoopInvoiceReadsContractV1 } from './stillLoopInvoiceReads.contract.js';

stillLoopInvoiceReadsContractV1('memory', async () => new InMemoryStillLoopInvoiceReadRepositoryV1());
