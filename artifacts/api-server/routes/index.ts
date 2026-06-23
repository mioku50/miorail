import { Router } from 'express';
import { memoryRouter } from './memory';
import { settingsRouter } from './settings';
import { chatRouter } from './chat';

export const routes = Router();

routes.use('/memory', memoryRouter);
routes.use('/settings', settingsRouter);
routes.use('/chat', chatRouter);
