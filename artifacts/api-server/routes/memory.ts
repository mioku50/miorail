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
        updatedAt: settings?.updatedAt?.toISOString() || null,
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

    const settings = await MemoryService.updateUserSettings(userId, { memoryMd });

    res.json(
      UpdateMemoryResponseSchema.parse({
        memoryMd: settings.memoryMd,
        updatedAt: settings.updatedAt?.toISOString(),
      })
    );
  } catch (error) {
    next(error);
  }
});
