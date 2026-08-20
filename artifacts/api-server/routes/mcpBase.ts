import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { logger } from '@mioagent/utils';
import {
  BaseMcpConsoleRequestV1Schema,
  BaseMcpConsoleResponseV1Schema,
  BaseMcpActionReconcileResponseV1Schema,
  BaseMcpActionReceiptListResponseV1Schema,
  BaseMcpPluginCatalogueResponseSchema,
  BaseMcpToolProbeResponseSchema,
} from '@mioagent/api-zod';
import {
  BASE_MCP_CATALOGUE_GENERATED_AT_V1,
  BASE_MCP_PLUGIN_CATALOGUE_V1,
  BASE_MCP_PROVIDER_INTENTS_BY_ID_V1,
} from '@mioagent/security';
import { baseMcpPluginDriftV1 } from '../lib/baseMcpPluginDrift.js';
import { runBaseMcpConsoleV1 } from '../lib/baseMcpConsole.js';
import { runReviewedBaseMcpPluginReadV1 } from '../lib/baseMcpReviewedPluginRuntime.js';
import {
  classifyBaseMcpExtensionIntentV1,
  listBaseMcpActionReceiptsV1,
  prepareBaseMcpSendActionV1,
  prepareBaseMcpX402ActionV1,
  reconcileBaseMcpActionV1,
} from '../lib/baseMcpExtensionActions.js';
import {
  prepareBaseMcpVirtualsAgentCreateV1,
} from '../lib/baseMcpVirtualsAction.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  baseMcpEnabledFromEnv,
  baseMcpServerUrlFromEnv,
} from '../lib/baseMcpStatus.js';
import {
  clearBaseMcpCredentialScope,
  clearBaseMcpOAuthStatesForUser,
  createBaseMcpOAuthProviderForUser,
  deleteBaseMcpOAuthState,
  loadBaseMcpOAuthState,
  markBaseMcpNeedsReauth,
  sanitizeReturnTo,
} from '../lib/baseMcpOAuthStore.js';
import { probeBaseMcpTools } from '../lib/baseMcpToolProbe.js';
import { verifyBaseMcpWalletMatchViaOAuth } from '../lib/baseMcpWalletReconciliation.js';
import { tenantUserId, tenantWalletAddress } from '../middleware/tenantAuth';
import { resolveBaseNameV1 } from '../lib/baseNameResolver.js';

export const mcpBaseRouter = Router();
/** Public, read-only catalogue surface. Kept separate so mounting it before
 * tenant auth cannot accidentally expose OAuth, console or action routes. */
export const mcpBasePublicRouter = Router();

export const mcpBaseRouteRuntime = {
  auth,
  logger,
  probeBaseMcpTools,
  verifyBaseMcpWalletMatchViaOAuth,
  baseMcpPluginDriftV1,
  runBaseMcpConsoleV1,
  runReviewedBaseMcpPluginReadV1,
  classifyBaseMcpExtensionIntentV1,
  resolveBaseNameV1,
  prepareBaseMcpSendActionV1,
  prepareBaseMcpX402ActionV1,
  reconcileBaseMcpActionV1,
  prepareBaseMcpVirtualsAgentCreateV1,
  listBaseMcpActionReceiptsV1,
};

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('Missing SESSION_SECRET configuration');
  return secret;
}

function publicOrigin(req: Request): string {
  const fromEnv = (process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'http';
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0]?.trim();
  const host = forwardedHost || req.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

function callbackUrl(req: Request): string {
  return `${publicOrigin(req)}/api/mcp/base/callback`;
}

function redirectWithParam(path: string, key: string, value: string): string {
  const safePath = sanitizeReturnTo(path);
  const url = new URL(safePath, 'http://local');
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function oauthErrorRedirect(code: string, returnTo = '/stream'): string {
  const url = new URL(sanitizeReturnTo(returnTo), 'http://local');
  url.searchParams.set('mcp', 'error');
  url.searchParams.set('code', code);
  return `${url.pathname}${url.search}`;
}

function requiredConnectConfig(): { serverUrl: URL | null; missingConfig: string[] } {
  const missingConfig: string[] = [];
  const serverUrl = baseMcpServerUrlFromEnv();

  if (!baseMcpEnabledFromEnv()) missingConfig.push('BASE_MCP_ENABLED');
  if (!serverUrl) missingConfig.push('BASE_MCP_SERVER_URL');
  if (!(process.env.SESSION_SECRET || '').trim()) missingConfig.push('SESSION_SECRET');

  return { serverUrl, missingConfig };
}

export function safeOAuthErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/authenticate data|decrypt|decipher|credential/i.test(message)) return 'credentials_invalid';
  if (/expired[_ ]token|token.*expired/i.test(message)) return 'expired_token';
  if (/refresh|invalid_grant/i.test(message)) return 'refresh_failed';
  return 'authorization_failed';
}

function logOAuthEvent(
  level: 'info' | 'warn',
  event: 'base-mcp-oauth-started' | 'base-mcp-oauth-callback-success' | 'base-mcp-oauth-callback-failed',
  meta: Record<string, unknown>,
) {
  mcpBaseRouteRuntime.logger[level](event, {
    event,
    provider: 'base-mcp',
    ...meta,
  });
}

mcpBaseRouter.get('/connect', async (req, res) => {
  const userId = tenantUserId(req);
  const requestedReturnTo = sanitizeReturnTo(typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined);
  const returnTo = req.query.popup === '1'
    ? redirectWithParam(requestedReturnTo, 'mcpPopup', '1')
    : requestedReturnTo;
  try {
    const { serverUrl, missingConfig } = requiredConnectConfig();
    if (missingConfig.length || !serverUrl) return res.redirect(oauthErrorRedirect('missing_config', returnTo));

    const secret = sessionSecret();
    const state = crypto.randomBytes(32).toString('base64url');
    let authorizationUrl: string | null = null;

    // An explicit Connect/Reconnect is a clean OAuth boundary. Never attempt to
    // decrypt or refresh stale credentials while starting a new browser flow.
    await clearBaseMcpOAuthStatesForUser(userId);
    await clearBaseMcpCredentialScope({ userId, scope: 'all' });

    const provider = createBaseMcpOAuthProviderForUser({
      userId,
      sessionSecret: secret,
      redirectUrl: callbackUrl(req),
      state,
      returnTo,
      onRedirectToAuthorization: (url) => {
        authorizationUrl = url.toString();
      },
    });

    logOAuthEvent('info', 'base-mcp-oauth-started', {
      userId,
      endpointHost: serverUrl.host,
      returnTo,
    });
    await mcpBaseRouteRuntime.auth(provider, { serverUrl });
    if (authorizationUrl) {
      return res.redirect(authorizationUrl);
    }

    return res.redirect(redirectWithParam(returnTo, 'mcp', 'connected'));
  } catch (error) {
    const errorCode = safeOAuthErrorCode(error);
    await markBaseMcpNeedsReauth({ userId, error: errorCode }).catch(() => undefined);
    logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', { userId, errorCode });
    return res.redirect(oauthErrorRedirect(errorCode, returnTo));
  }
});

mcpBaseRouter.get('/callback', async (req, res) => {
  const userId = tenantUserId(req);
  let pending: Awaited<ReturnType<typeof loadBaseMcpOAuthState>> = null;
  let serverUrl: URL | null = null;
  try {
    const config = requiredConnectConfig();
    serverUrl = config.serverUrl;
    if (config.missingConfig.length || !serverUrl) return res.redirect(oauthErrorRedirect('missing_config'));

    const secret = sessionSecret();
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (errorParam) {
      if (state) pending = await loadBaseMcpOAuthState({ userId, sessionSecret: secret, state });
      if (pending) await deleteBaseMcpOAuthState({ userId, sessionSecret: secret, state });
      await markBaseMcpNeedsReauth({ userId, error: 'authorization_failed' });
      logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
        userId,
        endpointHost: serverUrl.host,
        errorCode: 'authorization_failed',
      });
      return res.redirect(oauthErrorRedirect('authorization_failed', pending?.returnTo));
    }

    if (!code || !state) {
      logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
        userId,
        endpointHost: serverUrl.host,
        errorCode: 'missing_code_or_state',
      });
      return res.redirect(oauthErrorRedirect('authorization_failed'));
    }

    pending = await loadBaseMcpOAuthState({ userId, sessionSecret: secret, state });
    if (!pending) {
      logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
        userId,
        endpointHost: serverUrl.host,
        errorCode: 'invalid_or_expired_state',
      });
      return res.redirect(oauthErrorRedirect('authorization_failed'));
    }

    const provider = createBaseMcpOAuthProviderForUser({
      userId,
      sessionSecret: secret,
      redirectUrl: callbackUrl(req),
      state,
      returnTo: pending.returnTo,
    });

    await mcpBaseRouteRuntime.auth(provider, {
      serverUrl,
      authorizationCode: code,
    });
    await deleteBaseMcpOAuthState({ userId, sessionSecret: secret, state });

    logOAuthEvent('info', 'base-mcp-oauth-callback-success', {
      userId,
      endpointHost: serverUrl.host,
    });

    // T44: reconcile the Base MCP account wallet with the SIWE session wallet.
    // A mismatch never breaks OAuth — it is surfaced to the UI as a warning
    // param so the user can reconnect with the right account. Base MCP
    // send/swap remain blocked separately while the mismatch persists.
    const walletMatch = await mcpBaseRouteRuntime
      .verifyBaseMcpWalletMatchViaOAuth({
        userId,
        sessionSecret: secret,
        redirectUrl: callbackUrl(req),
        serverUrl,
        tenantAddress: tenantWalletAddress(req),
      })
      .catch(() => ({ match: true, mcpAddresses: [], checked: false }));
    if (walletMatch.checked && !walletMatch.match) {
      logOAuthEvent('warn', 'base-mcp-oauth-callback-success', {
        userId,
        endpointHost: serverUrl.host,
        walletMismatch: true,
      });
      const redirectPath = redirectWithParam(pending.returnTo, 'mcp', 'connected');
      return res.redirect(redirectWithParam(redirectPath, 'mcpWallet', 'mismatch'));
    }
    return res.redirect(redirectWithParam(pending.returnTo, 'mcp', 'connected'));
  } catch (error) {
    const errorCode = safeOAuthErrorCode(error);
    await markBaseMcpNeedsReauth({
      userId,
      error: errorCode,
    }).catch(() => undefined);
    if (pending) {
      const state = pending.state;
      const secret = process.env.SESSION_SECRET;
      if (secret) {
        await deleteBaseMcpOAuthState({ userId, sessionSecret: secret, state }).catch(() => undefined);
      }
      logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
        userId,
        endpointHost: serverUrl?.host,
        errorCode,
      });
      return res.redirect(oauthErrorRedirect(errorCode, pending.returnTo));
    }
    logOAuthEvent('warn', 'base-mcp-oauth-callback-failed', {
      userId,
      endpointHost: serverUrl?.host,
      errorCode,
    });
    return res.redirect(oauthErrorRedirect(errorCode));
  }
});

async function handleToolsProbe(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = tenantUserId(req);
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      return res.json(BaseMcpToolProbeResponseSchema.parse({
        status: 'degraded',
        endpointHost: baseMcpServerUrlFromEnv()?.host,
        toolsCount: 0,
        capabilities: {
          readOnly: 0,
          userConfirmedTransaction: 0,
          forbidden: 0,
          unknown: 0,
        },
        routing: { read: 0, action: 0, routable: 0, blocked: 0 },
        tools: [],
        checkedAt: new Date().toISOString(),
        errorCode: 'missing_config',
      }));
    }

    const result = await mcpBaseRouteRuntime.probeBaseMcpTools({
      userId,
      sessionSecret: secret,
      redirectUrl: callbackUrl(req),
    });
    return res.json(BaseMcpToolProbeResponseSchema.parse(result));
  } catch (error) {
    next(error);
  }
}

mcpBaseRouter.get('/tools', handleToolsProbe);
mcpBaseRouter.get('/probe', handleToolsProbe);

// The plugin catalogue. NOT behind the OAuth session, and not behind
// BASE_MCP_ENABLED either: which plugins Base publishes is public knowledge
// that does not change when a token expires. Hiding it behind the connection
// is what produced the screenshot where a disconnected user saw a page about
// Base MCP with no plugins on it.
mcpBasePublicRouter.get('/plugins', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const drift = await mcpBaseRouteRuntime.baseMcpPluginDriftV1();
    return res.json(BaseMcpPluginCatalogueResponseSchema.parse({
      plugins: BASE_MCP_PLUGIN_CATALOGUE_V1.map((plugin) => {
        const intents = BASE_MCP_PROVIDER_INTENTS_BY_ID_V1[plugin.id];
        if (!intents) throw new Error(`base_mcp_provider_intents_missing:${plugin.id}`);
        return {
          ...plugin,
          productSurface: intents.productSurface,
          lifecycleStage: intents.lifecycleStage,
          examples: intents.examples,
        };
      }),
      generatedAt: BASE_MCP_CATALOGUE_GENERATED_AT_V1,
      drift,
    }));
  } catch (error) {
    next(error);
  }
});

// The Base MCP Extensions console. A separate room from the Routes flow, on purpose: the
// tools here belong to third parties, and mixing them with Miorail's measured
// routes in one thread erases the difference between "we verified this" and
// "somebody's API said so". Deterministic routing intercepts routable and
// direct-action intent before the read-only agent runs. Only exact typed send,
// x402 and reviewed Virtuals verticals can reach an action; see the typed
// action modules. The generic model still receives read-only tools only.
mcpBaseRouter.post('/console', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { message, requestId } = BaseMcpConsoleRequestV1Schema.parse(req.body);
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      return res.json(BaseMcpConsoleResponseV1Schema.parse({
        status: 'disabled',
        reply: null,
        trace: [],
        toolsAvailable: 0,
        truncated: false,
        elapsedMs: 0,
        errorCode: 'missing_config',
        checkedAt: new Date().toISOString(),
      }));
    }

    let decision = mcpBaseRouteRuntime.classifyBaseMcpExtensionIntentV1(message);
    if (decision.kind === 'send_name') {
      const resolution = await mcpBaseRouteRuntime.resolveBaseNameV1(decision.intent.recipientName);
      if (resolution.outcome !== 'resolved') {
        const reply = resolution.outcome === 'unresolved'
          ? `No Base address is configured for ${resolution.name}. Check the Basename or send to an exact 0x address.`
          : resolution.outcome === 'invalid'
            ? 'That Basename is not valid. Use a normalized *.base.eth name or an exact 0x address.'
            : 'Basename resolution is temporarily unavailable. No send action was prepared; retry or use an exact 0x address.';
        res.setHeader('Cache-Control', 'no-store');
        return res.json(BaseMcpConsoleResponseV1Schema.parse({
          status: 'needs_input',
          reply,
          trace: [],
          toolsAvailable: 0,
          truncated: false,
          elapsedMs: 0,
          errorCode: resolution.errorCode,
          checkedAt: new Date().toISOString(),
        }));
      }
      decision = {
        kind: 'send',
        intent: {
          ...decision.intent,
          recipient: resolution.address.toLowerCase() as `0x${string}`,
          recipientName: resolution.name,
        },
      };
    }
    if (decision.kind === 'handoff') {
      return res.json(BaseMcpConsoleResponseV1Schema.parse({
        status: 'handoff',
        reply: 'This is a routable intent. It belongs in Routes AI, where providers are compared and the selected path passes the Safety Kernel.',
        trace: [],
        toolsAvailable: 0,
        truncated: false,
        elapsedMs: 0,
        errorCode: null,
        checkedAt: new Date().toISOString(),
        handoff: {
          target: 'routes',
          path: '/routes',
          reason: 'routable_intent',
          originalMessage: decision.originalMessage,
          provider: decision.provider,
        },
      }));
    }
    if (decision.kind === 'provider_handoff') {
      return res.json(BaseMcpConsoleResponseV1Schema.parse({
        status: 'handoff',
        reply: 'Avantis view data stays available in Extensions. Trade preparation on this UI surface continues in the official Avantis interface; no position has been opened or changed.',
        trace: [],
        toolsAvailable: 0,
        truncated: false,
        elapsedMs: 0,
        errorCode: null,
        checkedAt: new Date().toISOString(),
        handoff: decision.handoff,
      }));
    }
    if (decision.kind === 'needs_input') {
      return res.json(BaseMcpConsoleResponseV1Schema.parse({
        status: 'needs_input',
        reply: decision.reply,
        trace: [],
        toolsAvailable: 0,
        truncated: false,
        elapsedMs: 0,
        errorCode: decision.errorCode,
        checkedAt: new Date().toISOString(),
      }));
    }
    if (decision.kind === 'send') {
      if (!baseMcpEnabledFromEnv() || !baseMcpServerUrlFromEnv()) {
        return res.json(BaseMcpConsoleResponseV1Schema.parse({
          status: 'disabled',
          reply: null,
          trace: [],
          toolsAvailable: 0,
          truncated: false,
          elapsedMs: 0,
          errorCode: 'base_mcp_disabled',
          checkedAt: new Date().toISOString(),
        }));
      }
      const startedAt = Date.now();
      const result = await mcpBaseRouteRuntime.prepareBaseMcpSendActionV1({
        req,
        userId: tenantUserId(req),
        walletAddress: tenantWalletAddress(req),
        sessionSecret: secret,
        idempotencyKey: requestId,
        message,
        intent: decision.intent,
      });
      return res.json(BaseMcpConsoleResponseV1Schema.parse({
        status: result.kind,
        reply: result.reply,
        trace: [],
        toolsAvailable: result.toolsAvailable,
        truncated: false,
        elapsedMs: Date.now() - startedAt,
        errorCode: result.errorCode,
        checkedAt: new Date().toISOString(),
        action: result.receipt
          ? { receipt: result.receipt, approvalUrl: result.approvalUrl, resultPreview: result.resultPreview }
          : null,
      }));
    }
    if (decision.kind === 'x402') {
      if (!baseMcpEnabledFromEnv() || !baseMcpServerUrlFromEnv()) {
        return res.json(BaseMcpConsoleResponseV1Schema.parse({
          status: 'disabled', reply: null, trace: [], toolsAvailable: 0, truncated: false,
          elapsedMs: 0, errorCode: 'base_mcp_disabled', checkedAt: new Date().toISOString(),
        }));
      }
      const startedAt = Date.now();
      const result = await mcpBaseRouteRuntime.prepareBaseMcpX402ActionV1({
        req,
        userId: tenantUserId(req),
        walletAddress: tenantWalletAddress(req),
        sessionSecret: secret,
        idempotencyKey: requestId,
        message,
        intent: decision.intent,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(BaseMcpConsoleResponseV1Schema.parse({
        status: result.kind,
        reply: result.reply,
        trace: [],
        toolsAvailable: result.toolsAvailable,
        truncated: false,
        elapsedMs: Date.now() - startedAt,
        errorCode: result.errorCode,
        checkedAt: new Date().toISOString(),
        action: result.receipt
          ? { receipt: result.receipt, approvalUrl: result.approvalUrl, resultPreview: result.resultPreview }
          : null,
      }));
    }
    if (decision.kind === 'virtuals_create') {
      if (!baseMcpEnabledFromEnv() || !baseMcpServerUrlFromEnv()) {
        return res.json(BaseMcpConsoleResponseV1Schema.parse({
          status: 'disabled', reply: null, trace: [], toolsAvailable: 0, truncated: false,
          elapsedMs: 0, errorCode: 'base_mcp_disabled', checkedAt: new Date().toISOString(),
        }));
      }
      const startedAt = Date.now();
      const result = await mcpBaseRouteRuntime.prepareBaseMcpVirtualsAgentCreateV1({
        req,
        userId: tenantUserId(req),
        walletAddress: tenantWalletAddress(req),
        sessionSecret: secret,
        idempotencyKey: requestId,
        intent: decision.intent,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(BaseMcpConsoleResponseV1Schema.parse({
        status: result.kind,
        reply: result.reply,
        trace: [],
        toolsAvailable: result.toolsAvailable,
        truncated: false,
        elapsedMs: Date.now() - startedAt,
        errorCode: result.errorCode,
        checkedAt: new Date().toISOString(),
        action: result.receipt
          ? { receipt: result.receipt, approvalUrl: result.approvalUrl, resultPreview: result.resultPreview }
          : null,
      }));
    }

    const reviewed = await mcpBaseRouteRuntime.runReviewedBaseMcpPluginReadV1({
      providerId: decision.providerId,
      exampleId: decision.exampleId,
      message,
      walletAddress: tenantWalletAddress(req),
      userId: tenantUserId(req),
      sessionSecret: secret,
    });
    const result = reviewed ?? await mcpBaseRouteRuntime.runBaseMcpConsoleV1({
      req,
      userId: tenantUserId(req),
      sessionSecret: secret,
      walletAddress: tenantWalletAddress(req),
      message,
      providerPrompt: decision.providerPrompt,
      enabled: baseMcpEnabledFromEnv() && Boolean(baseMcpServerUrlFromEnv()),
    });
    return res.json(BaseMcpConsoleResponseV1Schema.parse(result));
  } catch (error) {
    next(error);
  }
});

/** Direct extension actions have their own durable receipts, never Route Proofs. */
mcpBaseRouter.get('/actions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const receipts = await mcpBaseRouteRuntime.listBaseMcpActionReceiptsV1(tenantUserId(req), 50);
    return res.json(BaseMcpActionReceiptListResponseV1Schema.parse({ receipts }));
  } catch (error) {
    next(error);
  }
});

mcpBaseRouter.post('/actions/:receiptId/reconcile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const secret = process.env.SESSION_SECRET;
    if (!secret) return res.status(503).json({ error: 'missing_config' });
    const receiptId = String(req.params.receiptId || '').slice(0, 200);
    const result = await mcpBaseRouteRuntime.reconcileBaseMcpActionV1({
      req,
      userId: tenantUserId(req),
      walletAddress: tenantWalletAddress(req),
      sessionSecret: secret,
      receiptId,
    });
    if (!result.receipt) return res.status(404).json({ error: result.errorCode || 'base_mcp_action_receipt_not_found' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(BaseMcpActionReconcileResponseV1Schema.parse({
      receipt: result.receipt,
      approvalUrl: result.approvalUrl,
      resultPreview: result.resultPreview,
    }));
  } catch (error) {
    next(error);
  }
});
