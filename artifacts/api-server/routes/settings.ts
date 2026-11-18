import { Router } from 'express';
import { MemoryService } from '@mioagent/memory';
import {
  SettingsResponseSchema,
  UpdateSettingsRequestSchema,
  UpdateSettingsResponseSchema,
} from '@mioagent/api-zod';
import { tenantUserId } from '../middleware/tenantAuth';

export const settingsRouter = Router();

// ---------------------------------------------------------------------------
// `protocolToggles` holds more than toggles. Autonomy keeps its policy there
// too, as an object under `autonomy` (routes/autonomy.ts), so every settings row
// that ever configured it answered GET /api/settings with a 500: the public
// schema describes boolean toggles only (audit P2 Settings, 2026-11-18). And a
// POST replaced the whole record, which would have erased that policy. These
// routes own the booleans and nothing else: they answer with the booleans, and
// a write merges new booleans into what is stored, keeping every other key.
// ---------------------------------------------------------------------------

/** The boolean toggles of a stored record; null when nothing is stored. */
export function booleanProtocolTogglesV1(stored: unknown): Record<string, boolean> | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  );
}

/** New toggles over the stored record. A key that holds something other than a
 * toggle, such as the Autonomy policy, is never overwritten by one. */
export function mergeProtocolTogglesV1(stored: unknown, toggles: Record<string, boolean>): Record<string, unknown> {
  const merged: Record<string, unknown> = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
  for (const [key, value] of Object.entries(toggles)) {
    if (merged[key] === undefined || typeof merged[key] === 'boolean') merged[key] = value;
  }
  return merged;
}

settingsRouter.get('/', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const settings = await MemoryService.getUserSettings(userId);

    res.json(
      SettingsResponseSchema.parse({
        chosenModel: settings?.model || null,
        protocolToggles: booleanProtocolTogglesV1(settings?.protocolToggles),
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
    if (data.protocolToggles !== undefined) {
      const stored = (await MemoryService.getUserSettings(userId))?.protocolToggles;
      updateData.protocolToggles = mergeProtocolTogglesV1(stored, data.protocolToggles);
    }

    await MemoryService.updateUserSettings(userId, updateData);
    const settings = await MemoryService.getUserSettings(userId);

    res.json(
      UpdateSettingsResponseSchema.parse({
        chosenModel: settings?.model || null,
        protocolToggles: booleanProtocolTogglesV1(settings?.protocolToggles),
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (error) {
    next(error);
  }
});
