import { Router } from 'express';
import { MemoryService } from '@mioagent/memory';
import {
  SettingsResponseSchema,
  UpdateSettingsRequestSchema,
  UpdateSettingsResponseSchema,
} from '@mioagent/api-zod';
import { tenantUserId } from '../middleware/tenantAuth';

export const settingsRouter = Router();

settingsRouter.get('/', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const settings = await MemoryService.getUserSettings(userId);

    res.json(
      SettingsResponseSchema.parse({
        chosenModel: settings?.model || null,
        protocolToggles: settings?.protocolToggles || null,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (error) {
    next(error);
  }
});

settingsRouter.post('/', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const data = UpdateSettingsRequestSchema.parse(req.body);

    const updateData: Record<string, unknown> = {};
    if (data.chosenModel !== undefined) updateData.model = data.chosenModel;
    if (data.protocolToggles !== undefined) updateData.protocolToggles = data.protocolToggles;

    await MemoryService.updateUserSettings(userId, updateData);
    const settings = await MemoryService.getUserSettings(userId);

    res.json(
      UpdateSettingsResponseSchema.parse({
        chosenModel: settings?.model || null,
        protocolToggles: settings?.protocolToggles || null,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (error) {
    next(error);
  }
});
