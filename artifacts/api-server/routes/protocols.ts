import { Router } from 'express';
import { MemoryService } from '@mioagent/memory';
import { ProtocolsListResponseSchema, ToggleProtocolResponseSchema } from '@mioagent/api-zod';
import { tenantUserId } from '../middleware/tenantAuth';

export const protocolsRouter = Router();

// TODO: These are hardcoded default protocols.
// In the future this should read from a dynamic registry or package configuration.
const DEFAULT_PROTOCOLS = [
  { id: 'base-mcp', name: 'Base MCP', description: 'Base operations', enabled: true },
  { id: 'moralis', name: 'Moralis', description: 'Token data', enabled: true },
  { id: 'coingecko', name: 'CoinGecko', description: 'Price feeds', enabled: true },
  { id: 'goplus', name: 'GoPlus', description: 'Security', enabled: true },
];

protocolsRouter.get('/', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const settings = await MemoryService.getUserSettings(userId);
    const toggles = settings?.protocolToggles || {};

    // Merge real user settings with the default list
    const protocols = DEFAULT_PROTOCOLS.map(p => ({
      ...p,
      enabled: toggles[p.id] !== undefined ? toggles[p.id] : p.enabled
    }));

    res.json(
      ProtocolsListResponseSchema.parse({ protocols })
    );
  } catch (error) {
    next(error);
  }
});

protocolsRouter.patch('/:id', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const protocolId = req.params.id;
    const enabled = req.body.enabled;

    // Ensure protocol toggles update the actual user settings in the DB
    const settings = await MemoryService.getUserSettings(userId);
    const toggles = settings?.protocolToggles || {};
    toggles[protocolId] = !!enabled;

    await MemoryService.updateUserSettings(userId, { protocolToggles: toggles });

    res.json(
      ToggleProtocolResponseSchema.parse({ success: true })
    );
  } catch (error) {
    next(error);
  }
});
