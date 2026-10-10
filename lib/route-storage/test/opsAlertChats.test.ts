import { InMemoryOpsAlertChatRepositoryV1 } from '../src/opsAlertChats.js';
import { opsAlertChatContractV1 } from './opsAlertChats.contract.js';

opsAlertChatContractV1('memory', async () => new InMemoryOpsAlertChatRepositoryV1());
