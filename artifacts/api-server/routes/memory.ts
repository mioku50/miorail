import { Router } from 'express';
import { MemoryService } from '@mioagent/memory';
import {
  UpdateMemoryRequestSchema,
  UpdateMemoryResponseSchema,
  MemoryResponseSchema,
} from '@mioagent/api-zod';
import { tenantUserId } from '../middleware/tenantAuth';

export const memoryRouter = Router();

memoryRouter.get('/', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const settings = await MemoryService.getUserSettings(userId);

    res.json(
      MemoryResponseSchema.parse({
        memoryMd: settings?.memoryMd || null,
        updatedAt: new Date().toISOString(), // we don't have updatedAt in the returned type from service, mock it
      })
    );
  } catch (error) {
    next(error);
  }
});

memoryRouter.post('/', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const { memoryMd } = UpdateMemoryRequestSchema.parse(req.body);

    await MemoryService.updateUserSettings(userId, { memoryMd });

    res.json(
      UpdateMemoryResponseSchema.parse({
        memoryMd,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (error) {
    next(error);
  }
});
