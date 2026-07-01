import { Router } from 'express';
import { memoryRouter } from './memory';
import { settingsRouter } from './settings';
import { chatRouter } from './chat';
import { actionsRouter } from './actions';
import { x402Router } from './x402';
import { workflowsRouter } from './workflows';
import { portfolioRouter } from './portfolio';
import { protocolsRouter } from './protocols';
import { statusRouter } from './status';

export const routes = Router();

routes.use('/memory', memoryRouter);
routes.use('/settings', settingsRouter);
routes.use('/chat', chatRouter);
routes.use('/actions', actionsRouter);
routes.use('/x402', x402Router);
routes.use('/workflows', workflowsRouter);
routes.use('/portfolio', portfolioRouter);
routes.use('/protocols', protocolsRouter);
routes.use('/status', statusRouter);

