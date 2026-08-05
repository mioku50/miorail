import { Router } from 'express';
import { memoryRouter } from './memory';
import { settingsRouter } from './settings';
import { chatRouter } from './chat';
import { actionsRouter } from './actions';
import { x402Router } from './x402';
import { workflowsRouter } from './workflows';
import { portfolioRouter } from './portfolio';
import { approvalsRouter } from './approvals';
import { protocolsRouter } from './protocols';
import { statusRouter } from './status';
import { marketRouter } from './market';
import { autonomyRouter } from './autonomy';
import { mcpBaseRouter } from './mcpBase';
import { mcpHandoffRouter } from './mcpHandoff';
import { authRouter } from './auth';
import { routeIntelligenceRouter } from './routeIntelligence';
import { publicProofRouter } from './publicProof';
import { enforceTenantBinding, requireTenant } from '../middleware/tenantAuth';

export const routes = Router();

routes.use('/auth', authRouter);
// T67C.2: mounted BEFORE requireTenant on purpose. A public proof opens with
// no session, no wallet and no SIWE; putting it behind the tenant middleware
// would make it unreadable by the only people it exists for.
routes.use('/public', publicProofRouter);
routes.use(requireTenant, enforceTenantBinding);
routes.use('/memory', memoryRouter);
routes.use('/settings', settingsRouter);
routes.use('/chat', chatRouter);
routes.use('/actions', actionsRouter);
routes.use('/x402', x402Router);
routes.use('/workflows', workflowsRouter);
routes.use('/portfolio', portfolioRouter);
routes.use('/approvals', approvalsRouter);
routes.use('/protocols', protocolsRouter);
routes.use('/status', statusRouter);
routes.use('/market', marketRouter);
routes.use('/autonomy', autonomyRouter);
routes.use('/mcp/base', mcpBaseRouter);
// T72-B §1 — minting a handoff token requires the session that already proved
// the wallet, so it lives behind the tenant gate while /mcp/private itself does
// not (an MCP client has no cookie to send).
routes.use('/mcp/handoff', mcpHandoffRouter);
routes.use('/route-intelligence', routeIntelligenceRouter);
