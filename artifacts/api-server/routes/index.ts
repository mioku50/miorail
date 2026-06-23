import { Router } from 'express';
import { memoryRouter } from './memory';
import { settingsRouter } from './settings';

export const routes = Router();

routes.use('/memory', memoryRouter);
routes.use('/settings', settingsRouter);
