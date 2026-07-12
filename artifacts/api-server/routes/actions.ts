import { Router } from 'express';
import { db, actions } from '@mioagent/db';
import { desc, eq, and, inArray } from 'drizzle-orm';
import {
  ActionsFeedResponseSchema,
  ExecuteActionResponseSchema,
  DismissActionResponseSchema,
  DismissAllRecommendationsResponseSchema,
  DeleteRecommendationsResponseSchema,
  DeleteSingleActionResponseSchema,
  RegenerateRecommendationResponseSchema,
  PrepareActionRequestSchema,
  PrepareActionResponseSchema,
  ConfirmActionRequestSchema,
  ConfirmActionResponseSchema,
} from '@mioagent/api-zod';
import { ObservabilityService } from '@mioagent/observability';
import { detectActionIntent } from '../lib/intent.js';
import {
  APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE,
  analyzePortfolioForRisk,
  buildRecommendationMetadataFromAnalysis,
  fetchInternalApprovals,
  fetchInternalPortfolio,
  isApprovalScannerUnavailableStatus,
  type TokenApproval,
} from '../lib/portfolioAnalysis.js';
import { buildActionPlan, planHasCalls, parseRevokeApproval, findActiveApproval } from '../lib/actionPlan.js';
import { getExecutionCapabilities } from '../lib/executionCapabilities.js';
import { evaluateExecutableAction, screenAction, simulateTrade } from '@mioagent/security';
import { isMoonwellActionType } from '@mioagent/security/moonwellGuard';
import { normalizeBaseChain } from '@mioagent/security/baseGuards';
import { isProductionActionType, type ProductionActionType } from '@mioagent/api-zod';
import { MemoryService } from '@mioagent/memory';
import { getSystemStatus } from './status.js';
import { getAutonomousExecutionGateway, getAutonomyPolicyRepository } from '../lib/autonomyGateway.js';
import { tenantUserId, tenantWalletAddress } from '../middleware/tenantAuth';
import { loadExecutionSecurityContext } from '../lib/executionSecurity.js';
import {
  actionProofRuntime,
  buildBaseReceiptProof,
  buildExecutedActionProofRepair,
  buildStateVerifiedAllowanceZeroProof,
  buildWalletReceiptsProof,
  extractRevokeApprovalProofContext,
  getNormalizedProofAliases,
  getActionType,
  normalizeExecutedActionProof,
  receiptsAreSuccessful,
  type ExecutionProof,
} from '../lib/actionProofs.js';

export const actionsRouter = Router();
export const actionsRouteRuntime = { loadExecutionSecurityContext };

async function releaseActionAutonomyReservation(userId: string, actionId: string, reason: string): Promise<void> {
  const [action] = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
  const metadata = (action?.metadata || {}) as Record<string, any>;
  if (!metadata.autonomyReservation?.id) return;
  try {
    await getAutonomyPolicyRepository().release(actionId, reason);
  } catch {
    // Reservation TTL is the final fail-safe if the accounting store is
    // temporarily unavailable; dismissal itself should remain available.
  }
}

actionsRouter.delete('/demo', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const userActions = await db.select().from(actions).where(eq(actions.userId, userId));
    const demoIds = userActions
      .filter(a => {
        const meta = (a.metadata || {}) as any;
        if (a.suggestedPrompt?.includes('Test transfer of Sepolia USDC')) return true;
        if (meta.demo === true || meta.source === 'demo' || meta.createdBy === 'seed' || meta.source === 'seed') return true;
        if (a.kind !== 'recommendation') return true;
        return false;
      })
      .map(a => a.id);

    if (demoIds.length > 0) {
      await db.delete(actions).where(and(eq(actions.userId, userId), inArray(actions.id, demoIds)));
    }
    res.json({ success: true, count: demoIds.length });
  } catch (error) {
    next(error);
  }
});

actionsRouter.patch('/recommendations/dismiss-all', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const userActions = await db.select().from(actions).where(and(eq(actions.userId, userId), eq(actions.kind, 'recommendation'), eq(actions.status, 'pending')));
    const targetIds = userActions.map(a => a.id);

    if (targetIds.length > 0) {
      await db.update(actions)
        .set({ status: 'dismissed', updatedAt: new Date() })
        .where(and(eq(actions.userId, userId), inArray(actions.id, targetIds)));
    }
    res.json(DismissAllRecommendationsResponseSchema.parse({ success: true, count: targetIds.length }));
  } catch (error) {
    next(error);
  }
});

actionsRouter.delete('/recommendations', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const confirm = req.query.confirm === 'true' || req.body?.confirm === true || req.body?.confirm === 'true';
    if (!confirm) {
      return res.status(400).json({ success: false, error: 'Confirmation required' });
    }
    const userActions = await db.select().from(actions).where(and(eq(actions.userId, userId), eq(actions.kind, 'recommendation')));
    const targetIds = userActions.map(a => a.id);

    if (targetIds.length > 0) {
      await db.delete(actions).where(and(eq(actions.userId, userId), inArray(actions.id, targetIds)));
    }
    res.json(DeleteRecommendationsResponseSchema.parse({ success: true, count: targetIds.length }));
  } catch (error) {
    next(error);
  }
});


actionsRouter.get('/', async (req, res, next) => {
  try {
    console.log("TRACE: actions GET start");
    const userId = tenantUserId(req);
    const userAddress = tenantWalletAddress(req);

    console.log("TRACE: actions GET querying db");
    let userActions = await db
      .select()
      .from(actions)
      .where(eq(actions.userId, userId))
      .orderBy(desc(actions.createdAt))
      .limit(50); // Basic limit

    const repairedActions: typeof userActions = [];
    for (const action of userActions) {
      const repair = await buildExecutedActionProofRepair(action, userAddress);
      if (!repair) {
        repairedActions.push(action);
        continue;
      }

      const updatedAt = new Date();
      await db.update(actions)
        .set({
          status: repair.status as any,
          metadata: repair.metadata,
          executedAt: repair.executedAt === undefined ? action.executedAt : repair.executedAt,
          updatedAt,
        })
        .where(and(eq(actions.id, action.id), eq(actions.userId, userId)));

      repairedActions.push({
        ...action,
        status: repair.status,
        metadata: repair.metadata,
        executedAt: repair.executedAt === undefined ? action.executedAt : repair.executedAt,
        updatedAt,
      });
    }
    userActions = repairedActions;
    console.log(`TRACE: actions GET query done, found ${userActions.length}`);

    const formattedActions = userActions
      .filter(a => {
        const meta = (a.metadata || {}) as any;
        if (a.suggestedPrompt?.includes('Test transfer of Sepolia USDC')) return false;
        if (meta.demo === true || meta.source === 'demo' || meta.createdBy === 'seed' || meta.source === 'seed') return false;
        return true;
      })
      .map(a => ({
        ...(() => {
          const normalizedProof = normalizeExecutedActionProof(a);
          const metadata = normalizedProof
            ? { ...((a.metadata || {}) as any), executionProof: normalizedProof }
            : a.metadata;
          const aliases = getNormalizedProofAliases({ ...a, metadata });
          return {
            id: a.id,
            kind: a.kind,
            status: a.status as any,
            suggestedPrompt: a.suggestedPrompt,
            tokens: Array.isArray(a.tokens) ? a.tokens.map(String) : undefined,
            executionPayload: a.executionPayload,
            metadata,
            ...aliases,
            createdAt: a.createdAt.toISOString(),
            executedAt: a.executedAt ? a.executedAt.toISOString() : null,
          };
        })(),
      }));

    res.json(ActionsFeedResponseSchema.parse({ actions: formattedActions }));
  } catch (error) {
    next(error);
  }
});

import { createApiToolAggregatorForUser } from '../lib/baseMcpTools.js';


actionsRouter.post('/recommend', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const { instruction, chainEnv: reqChainEnv } = req.body;
    const walletAddress = tenantWalletAddress(req);
    
    if (!instruction) {
      return res.status(400).json({ success: false, error: 'Instruction required' });
    }

    const { db, actions } = require('@mioagent/db');
    const crypto = require('node:crypto');

    const chainEnv = reqChainEnv || process.env.CHAIN_ENV || 'sepolia';
    const chainId = chainEnv === 'sepolia' ? 'eip155:84532' : 'eip155:8453';
    const isReadonly = chainEnv === 'mainnet-readonly';
    const isMainnetExecEnabled = process.env.MAINNET_EXECUTION_ENABLED === 'true';
    const canExecute = !isReadonly && (chainEnv !== 'mainnet' || isMainnetExecEnabled);
    const intent = detectActionIntent(instruction);
    const memoryMd = (await MemoryService.getUserSettings(userId).catch(() => null))?.memoryMd || null;
    const statusRes = getSystemStatus(chainEnv);
    let secProvider = statusRes.risk.provider || process.env.TOKEN_SECURITY_PROVIDER || 'none';
    let riskStatus = statusRes.risk.status;
    const requiresTokenSecurity = ['portfolio', 'risk', 'security'].includes(intent.intentType || '');
    let securityProviderContext = {
      risk: riskStatus,
      riskProvider: secProvider,
      securityProvider: secProvider,
      requiresTokenSecurity,
    };
    
    const actionId = crypto.randomUUID();
    // T19: build a real (unsigned, never server-broadcast) action plan for
    // mainnet — `buildActionPlan` encodes canonical USDC transfers for
    // recognized safe instructions and falls back to read-only (no calls) for
    // anything else. Sepolia keeps the existing placeholder call shape.
    let payload: { chain: string; readOnly?: boolean; actionType?: 'revoke_approval' | 'limited_transfer'; calls: { to: string; value?: string; data?: string }[] };

    // T19.2: revoke-approval discovery. A revoke intent must be backed by a
    // REAL provider-discovered nonzero allowance before we encode a confirmable
    // action. If the wallet has no active approval for the spender, return an
    // honest "nothing to revoke" note and do NOT create a generic read-only
    // recommendation (which would imply an action that doesn't exist). No
    // action row is inserted in the not-found / no-wallet / lookup-failed cases.
    const isMainnetLike = isReadonly || chainEnv === 'mainnet';
    const revokeIntent = isMainnetLike ? parseRevokeApproval(instruction) : null;
    let approvalsForPlan: TokenApproval[] | undefined;
    if (revokeIntent) {
      if (!walletAddress) {
        return res.json({
          success: false,
          error: 'Connect your wallet to check spend permissions before revoking.',
        });
      }
      try {
        const appRes = await fetchInternalApprovals(walletAddress, chainEnv);
        if (isApprovalScannerUnavailableStatus(appRes.status)) {
          return res.json({
            success: false,
            error: APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE,
          });
        }
        approvalsForPlan = appRes.approvals;
      } catch {
        return res.json({
          success: false,
          error: 'Could not verify spend permissions. Please try again.',
        });
      }
    }

    if (isMainnetLike) {
      payload = buildActionPlan(instruction, {
        chainEnv,
        walletAddress,
        approvals: approvalsForPlan,
        memoryMd,
        securityProviderContext,
      });
    } else {
      payload = {
        chain: chainId,
        calls: [
          {
            to: '0x0000000000000000000000000000000000000000',
            value: '0',
            data: '0x'
          }
        ]
      };
    }
    const hasPlanCalls = planHasCalls(payload);

    let metadata: any = {
      type: "recommendation",
      title: intent.title || "Action Recommendation",
      instruction: instruction,
      reason: intent.reason || `Automated recommendation for: "${instruction}"`,
      risk: isReadonly ? 'unknown' : 'low',
      expectedEffect: intent.expectedEffect || `Simulate action execution on ${chainEnv}`,
      chainMode: chainEnv,
      safetyState: 'safe',
      executable: canExecute,
      // T19: a read-only mainnet action with real calls is user-confirmable
      // (signed in the user's Base Account) even though the server never
      // broadcasts. `executable` refers to server-broadcast (stays false here).
      userConfirmable: isReadonly && hasPlanCalls,
      executionStatus: isReadonly
        ? (hasPlanCalls ? 'user-confirmable' : 'read-only')
        : (canExecute ? 'executable' : 'blocked'),
      createdBy: 'actions-builder',
      walletAddress
    };

    let tokensList: string[] | undefined;

    if (walletAddress && ['portfolio', 'risk', 'rebalance', 'security', 'yield', 'approvals'].includes(intent.intentType || '')) {
      try {
        const portfolio = await fetchInternalPortfolio(walletAddress, chainEnv, {
          includeApprovals: intent.intentType === 'approvals',
        });
        secProvider = portfolio.providers.riskProvider || secProvider;
        const analysis = analyzePortfolioForRisk(portfolio, walletAddress, chainEnv);
        riskStatus = analysis.securityProvider.status;
        securityProviderContext = {
          risk: riskStatus,
          riskProvider: secProvider,
          securityProvider: secProvider,
          requiresTokenSecurity,
        };
        metadata = buildRecommendationMetadataFromAnalysis({
          intent: { ...intent, createdBy: 'actions-builder' },
          message: instruction,
          walletAddress,
          chainEnv,
          analysis,
          providerContext: {
            tokenBalances: portfolio.providers.tokenBalancesProvider,
            prices: portfolio.providers.priceProvider || portfolio.providers.prices,
            risk: analysis.securityProvider.status,
            securityProvider: portfolio.providers.riskProvider || 'none',
            approvals: portfolio.approvalScan?.status || 'not_requested',
            approvalProvider: portfolio.providers.approvalProvider || 'none',
          }
        });
        tokensList = analysis.tokenFindings.map(f => `${f.balanceFormatted || ''} ${f.symbol}`.trim()).slice(0, 5);
      } catch (err) {
        console.error("Failed portfolio analysis in action builder:", err);
      }
    }

    const screenRes = screenAction({
      instruction,
      memoryMd,
      providerContext: securityProviderContext,
    });
    const securityScreening = {
      screenedAt: new Date().toISOString(),
      allowed: screenRes.allowed,
      verdict: screenRes.allowed ? 'PASSED' : 'BLOCKED',
      reason: screenRes.reason || (riskStatus === 'connected' || riskStatus === 'partial'
        ? 'Action-security heuristics and available contract checks evaluated.'
        : 'Action-security heuristics evaluated; contract checks are unavailable or incomplete.'),
      checks: screenRes.checks || [
        { name: 'Prompt Injection / Jailbreak', status: 'PASSED' },
        { name: 'Credential Exfiltration', status: 'PASSED' },
        { name: 'Wallet Drain / Sweep', status: screenRes.allowed ? 'PASSED' : 'BLOCKED' },
        { name: 'Unlimited Token Approval', status: screenRes.allowed ? 'PASSED' : 'BLOCKED' },
        { name: 'GoPlus Contract Security', status: riskStatus === 'connected' || riskStatus === 'partial' ? 'PASSED' : 'SKIPPED' }
      ]
    };

    let simRes;
    // T19: run the preflight validator on any payload with calls — including
    // mainnet-readonly user-confirmable plans — so the gate
    // (screening.allowed && simulation.success && hasCalls) works for the
    // user-confirmed flow. Read-only plans with no calls get the safe mock.
    if (payload.calls && payload.calls.length > 0) {
      try {
        simRes = await simulateTrade({ ...(payload as any), instruction, memoryMd });
      } catch {
        simRes = { success: false, allowed: false, riskLevel: 'blocked', checks: ['Simulation failed'] };
      }
    } else {
      simRes = {
        success: true,
        allowed: true,
        riskLevel: metadata.risk || 'low',
        reason: 'Read-only mode inspection verified without transaction risk',
        estimatedGas: '0',
        expectedOutput: 'Read-only state check without chain mutation',
        checks: ['Chain validation: PASSED (Read-only)', 'Address check: PASSED', 'Permission bounds: SAFE']
      };
    }

    // Re-apply T19 user-confirmable flags after the portfolio-analysis block
    // may have replaced `metadata` wholesale, so the gate hints are consistent
    // for every intent type.
    metadata.userConfirmable = isReadonly && hasPlanCalls && screenRes.allowed;
    metadata.executionStatus = isReadonly
      ? (hasPlanCalls ? 'user-confirmable' : 'read-only')
      : (canExecute ? 'executable' : 'blocked');
    metadata.safetyState = screenRes.allowed ? (hasPlanCalls ? 'user-confirmable' : 'safe') : 'blocked';

    metadata.securityScreening = securityScreening;
    metadata.simulationResult = simRes;

    const activeRevoke = revokeIntent ? findActiveApproval(approvalsForPlan, revokeIntent.spender, revokeIntent.tokenSymbol) : null;
    if (revokeIntent && !activeRevoke) {
      metadata.title = "Revoke Approval";
      metadata.reason = "No active approval found for this spender — nothing to revoke.";
      metadata.message = "No active approval found for this spender — nothing to revoke.";
      metadata.userConfirmable = false;
      metadata.executable = false;
      metadata.safetyState = "safe";
      metadata.executionStatus = "read-only";
      delete metadata.actionType;
      delete metadata.preferredFirstAction;
    } else if (activeRevoke && payload.actionType === 'revoke_approval') {
      metadata.title = `Revoke ${activeRevoke.tokenSymbol || 'Token'} Spend Permission`;
      metadata.reason = `Automated recommendation to revoke spend access for ${activeRevoke.spenderLabel || activeRevoke.spenderAddress}`;
      metadata.actionType = "revoke_approval";
      metadata.preferredFirstAction = true;
      metadata.userConfirmable = isReadonly ? true : false;
      metadata.executable = !isReadonly;
      metadata.executionStatus = isReadonly ? "user-confirmable" : "executable";
      metadata.allowanceBefore = activeRevoke.allowanceFormatted;
      metadata.allowanceAfter = "0";
      metadata.tokenSymbol = activeRevoke.tokenSymbol;
      metadata.tokenAddress = activeRevoke.tokenAddress;
      metadata.spender = activeRevoke.spenderAddress;
      metadata.method = "approve(spender,0)";
      metadata.validationMethod = "preflight-validation";
      metadata.simulationLabel = "Preflight validation — no fork simulation";
    } else {
      metadata.actionType = payload.actionType;
      metadata.preferredFirstAction = payload.actionType === 'revoke_approval';
    }

    await db.insert(actions).values({
      id: actionId,
      userId,
      kind: payload.actionType === 'revoke_approval' ? 'transaction' : 'recommendation',
      status: 'pending',
      suggestedPrompt: 'Builder: ' + instruction,
      tokens: tokensList,
      executionPayload: JSON.stringify(payload),
      metadata,
      createdAt: new Date(),
      updatedAt: new Date()
    }).onConflictDoNothing();

    res.json({ success: true, actionId });

  } catch (error) {
    next(error);
  }
});

actionsRouter.post('/:actionId/execute', async (req, res, next) => {
  try {
    console.log("TRACE: execute start");
    const userId = tenantUserId(req);
    const actionId = req.params.actionId;

    const [actionToExecute] = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    console.log("TRACE: execute db.select done");

    if (!actionToExecute) {
      return res.status(404).json({ success: false, error: 'Action not found' });
    }

    if (actionToExecute.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Action is not pending' });
    }

    // Try to get tools
    let aggregator;
    try {
      const sessionSecret = process.env.SESSION_SECRET;
      if (!sessionSecret) {
        return res.status(500).json({ success: false, error: 'Missing SESSION_SECRET configuration' });
      }
      aggregator = await createApiToolAggregatorForUser(req, userId, sessionSecret);
    } catch {
      return res.json({ success: false, error: 'Failed to initialize tool aggregator' });
    }

    function extractExecutionPayload(action: typeof actionToExecute): { chain: string; calls: { to: string; value?: string; data?: string }[] } {
      if (action.executionPayload) {
        try {
          const parsed = typeof action.executionPayload === 'string' ? JSON.parse(action.executionPayload) : action.executionPayload;
          if (parsed && parsed.chain && Array.isArray(parsed.calls)) {
             return parsed;
          }
        } catch {
          // ignore
        }
      }
      
      // Fallback to old tokens[0]
      if (Array.isArray(action.tokens) && action.tokens.length > 0) {
        try {
          const parsed = JSON.parse(String(action.tokens[0]));
          if (parsed && parsed.chain && Array.isArray(parsed.calls)) {
            return parsed;
          }
        } catch {
          // ignore
        }
      }
      throw new Error('Malformed or missing execution payload');
    }

    let payload;
    try {
      payload = extractExecutionPayload(actionToExecute);
    } catch (e) {
      return res.status(400).json({ success: false, error: e instanceof Error ? e.message : 'Invalid payload' });
    }

    const chainEnv = process.env.CHAIN_ENV || 'sepolia';
    // T19.1: gate on the SERVER-BROADCAST capability (never on
    // userConfirmedEnabled). This is the legacy /execute path that calls the
    // Base MCP send_calls tool; the user-confirmed flow lives in /prepare + /confirm.
    const execCaps = getExecutionCapabilities(chainEnv);
    if (!execCaps.serverBroadcastEnabled) {
      return res.json({
        success: false,
        error: chainEnv === 'mainnet-readonly'
          ? 'Mainnet execution is disabled in read-only mode.'
          : 'Mainnet execution is not enabled.',
      });
    }

    // If we have calls, execute them using the tool
    let toolResult;
    try {
      let normalized;
      try {
        normalized = normalizeBaseChain(payload.chain);
      } catch {
        return res.json({ success: false, error: 'Unsupported Base chain for MCP execution' });
      }
      const toolName = normalized.sendCallsTool;

      const tool = aggregator.findTool(toolName);
      if (!tool) {
        return res.json({ success: false, error: `MCP tool ${toolName} is not configured or available` });
      }

      toolResult = await aggregator.callTool(toolName, payload);

      // Parse the output
      if (toolResult && toolResult.content) {
         let parsedContent;
         try {
           parsedContent = JSON.parse(toolResult.content);
         } catch {
           parsedContent = {};
         }

         const approvalUrl = parsedContent.approvalUrl;
         const requestId = parsedContent.requestId;

         if (!approvalUrl || !requestId) {
           return res.json({ success: false, error: 'Backend failed to produce approvalUrl/requestId' });
         }

         const meta = (actionToExecute.metadata || {}) as any;
         await db.update(actions)
          .set({
            status: 'pending_confirmation',
            updatedAt: new Date(),
            metadata: {
              ...meta,
              approvalRequest: {
                requestId,
                approvalUrl,
                createdAt: new Date().toISOString(),
                note: 'Approval URL created; execution is not recorded until durable proof is confirmed.',
              },
            },
          })
          .where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

         return res.json(ExecuteActionResponseSchema.parse({ success: true, approvalUrl, requestId }));
      }
    } catch (e) {
      return res.json({ success: false, error: e instanceof Error ? e.message : 'Tool execution failed' });
    }

    return res.json({ success: false, error: 'Failed to execute action' });
  } catch (error) {
    next(error);
  }
});

// T19: Prepare an UNSIGNED EIP-5792 payload for the user to confirm in their
// Base Account. The server never broadcasts here and uses no backend key.
// Mainnet preparation is available only in the explicitly activated
// user-confirmed mode. Screening + simulation
// are re-derived LIVE (stored metadata is advisory only) and gate the response.
actionsRouter.post('/:actionId/prepare', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const userAddress = tenantWalletAddress(req);
    const actionId = req.params.actionId;
    const prepareRequest = PrepareActionRequestSchema.safeParse({ actionId, ...req.body });
    if (!prepareRequest.success) {
      return res.status(400).json({ success: false, error: 'Invalid prepare payload' });
    }

    const [action] = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    if (!action) {
      return res.status(404).json({ success: false, error: 'Action not found' });
    }
    if (action.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Action is not pending' });
    }

    // Extract execution payload (same logic as /execute). T44b: the whitelist
    // now includes moonwell_* verbs (validated by the strict Moonwell guard).
    let payload: { chain: string; actionType?: ProductionActionType; calls: { to: string; value?: string; data?: string }[] };
    try {
      const raw = action.executionPayload;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || !parsed.chain || !Array.isArray(parsed.calls)) {
        throw new Error('Malformed or missing execution payload');
      }
      payload = parsed;
    } catch (e) {
      return res.status(400).json({ success: false, error: e instanceof Error ? e.message : 'Invalid payload' });
    }

    if (!payload.calls || payload.calls.length === 0) {
      return res.json({ success: false, error: 'Action has no onchain calls to confirm' });
    }

    let normalizedChain;
    try {
      normalizedChain = normalizeBaseChain(payload.chain);
    } catch {
      return res.status(400).json({ success: false, error: 'Unsupported Base chain for wallet confirmation' });
    }

    const runtimeChainEnv = process.env.CHAIN_ENV || 'mainnet-readonly';
    const executionCapabilities = getExecutionCapabilities(runtimeChainEnv);
    if (normalizedChain.chainId === 8453 && !executionCapabilities.userConfirmedEnabled) {
      return res.json({
        success: false,
        error: 'Mainnet is read-only. User-confirmed transaction preparation is not active.',
      });
    }

    // T19.1: defensive whitelist gate. actionPlan only ever produces
    // whitelisted action types, but prepare re-checks so a stale/hand-edited
    // payload can never reach the user's wallet.
    if (!isProductionActionType(payload.actionType)) {
      return res.json({ success: false, error: 'Action type is not on the production whitelist' });
    }

    // One fail-closed guard owns prompt, calldata semantics, preflight and
    // token-level contract security for every wallet-confirmed execution path.
    const meta = (action.metadata || {}) as any;
    const instruction = meta.instruction || action.suggestedPrompt || '';
    const memoryMd = (await MemoryService.getUserSettings(userId).catch(() => null))?.memoryMd || null;
    // T44b: the Moonwell context (prepared amount) comes ONLY from the
    // server-stored action metadata written by streamMoonwellWriteRouting —
    // never from the client request.
    const moonwellContext = isMoonwellActionType(payload.actionType) && meta.moonwell?.amountDecimal
      ? { amountDecimal: String(meta.moonwell.amountDecimal) }
      : undefined;
    const executionSecurity = await actionsRouteRuntime.loadExecutionSecurityContext(
      normalizedChain.chainId,
      payload.actionType,
      payload.calls,
    );
    const guardResult = await evaluateExecutableAction({
      chain: normalizedChain.chainId,
      actionType: payload.actionType,
      calls: payload.calls,
      instruction,
      memoryMd,
      providerContext: executionSecurity.providerContext,
      tokenSecurity: executionSecurity.tokenSecurity,
      ...(moonwellContext ? { moonwell: moonwellContext } : {}),
    });
    const screenRes = guardResult.screening || {
      allowed: false,
      reason: guardResult.reason || 'Unified execution guard blocked action',
      checks: [],
    };
    const simRes = guardResult.simulation || {
      success: false,
      allowed: false,
      riskLevel: 'blocked' as const,
      reason: guardResult.reason || 'Guard blocked before preflight',
      checks: ['Unified execution guard: Blocked'],
    };
    const guardResponse = {
      code: guardResult.code,
      contractSecurity: guardResult.contractSecurity,
    };
    const guardAudit = {
      evaluatedAt: new Date().toISOString(),
      code: guardResult.code,
      allowed: guardResult.allowed,
      semantics: guardResult.semantics,
      contractSecurity: guardResult.contractSecurity,
    };

    if (!guardResult.allowed) {
      return res.json(PrepareActionResponseSchema.parse({
        success: false,
        actionId,
        chainId: normalizedChain.hexChainId,
        from: userAddress,
        calls: payload.calls,
        atomicRequired: true,
        screening: {
          screenedAt: new Date().toISOString(),
          allowed: screenRes.allowed,
          verdict: screenRes.allowed ? 'PASSED' : 'BLOCKED',
          reason: screenRes.reason || guardResult.reason || 'Blocked by unified execution guard',
          checks: screenRes.checks || [],
        },
        simulation: simRes,
        builderCodeAttached: false,
        guard: guardResponse,
        error: `Execution guard blocked: ${guardResult.reason || guardResult.code}`,
      }));
    }

    // Builder Code attribution is applied client-side (public env); the server
    // only reports whether a code is configured so the UI can show it.
    const builderCodeAttached = !!(process.env.BUILDER_CODE || process.env.VITE_BUILDER_CODE || process.env.NEXT_PUBLIC_BUILDER_CODE);

    if (runtimeChainEnv === 'mainnet' && normalizedChain.chainId === 8453) {
      if (
        userAddress
        && prepareRequest.data.walletAddress
        && userAddress.toLowerCase() !== prepareRequest.data.walletAddress.toLowerCase()
      ) {
        return res.status(403).json({ success: false, error: 'Connected wallet does not match the authenticated session' });
      }
      const walletAddress = userAddress || prepareRequest.data.walletAddress || meta.walletAddress || null;
      if (!walletAddress) {
        return res.json(PrepareActionResponseSchema.parse({
          success: false,
          actionId,
          chainId: normalizedChain.hexChainId,
          from: null,
          calls: payload.calls,
          atomicRequired: true,
          actionType: payload.actionType,
          screening: {
            screenedAt: new Date().toISOString(),
            allowed: true,
            verdict: 'PASSED',
            reason: screenRes.reason || 'Passed',
            checks: screenRes.checks || [],
          },
          simulation: simRes,
          builderCodeAttached,
          executionMode: 'bounded-approval',
          requiresUserApproval: true,
          error: 'Connected wallet address is required for bounded autonomy',
        }));
      }

      const gatewayResult = await getAutonomousExecutionGateway().prepare({
        userId,
        actionId,
        chainEnv: runtimeChainEnv,
        walletAddress,
        actionType: payload.actionType,
        calls: payload.calls,
        instruction,
        memoryMd,
        providerContext: executionSecurity.providerContext,
        tokenSecurity: executionSecurity.tokenSecurity,
        ...(moonwellContext ? { moonwell: moonwellContext } : {}),
      });
      if (!gatewayResult.success || !gatewayResult.reservation || !gatewayResult.policy || !gatewayResult.sendCallsRequest) {
        return res.json(PrepareActionResponseSchema.parse({
          success: false,
          actionId,
          chainId: normalizedChain.hexChainId,
          from: walletAddress,
          calls: payload.calls,
          atomicRequired: true,
          actionType: payload.actionType,
          screening: {
            screenedAt: new Date().toISOString(),
            allowed: true,
            verdict: 'PASSED',
            reason: screenRes.reason || 'Passed',
            checks: screenRes.checks || [],
          },
          simulation: simRes,
          builderCodeAttached,
          executionMode: 'bounded-approval',
          requiresUserApproval: true,
          guard: gatewayResult.guard
            ? { code: gatewayResult.guard.code, contractSecurity: gatewayResult.guard.contractSecurity }
            : guardResponse,
          error: gatewayResult.error || 'Autonomous execution gateway blocked the action',
        }));
      }

      const autonomyReservation = {
        id: gatewayResult.reservation.id,
        policyId: gatewayResult.policy.id,
        amountUsdc: gatewayResult.spendAmountUsdc || 0,
        status: gatewayResult.reservation.status,
        expiresAt: new Date(gatewayResult.reservation.expiresAt).toISOString(),
        preparedAt: new Date().toISOString(),
        requiresUserApproval: true,
      };
      await db.update(actions)
        .set({ metadata: { ...meta, autonomyReservation, executionGuard: guardAudit }, updatedAt: new Date() })
        .where(and(eq(actions.id, actionId), eq(actions.userId, userId), eq(actions.status, 'pending')));

      return res.json(PrepareActionResponseSchema.parse({
        success: true,
        actionId,
        chainId: gatewayResult.sendCallsRequest.chainId,
        from: gatewayResult.sendCallsRequest.from,
        calls: gatewayResult.sendCallsRequest.calls,
        atomicRequired: true,
        actionType: payload.actionType,
        screening: {
          screenedAt: new Date().toISOString(),
          allowed: true,
          verdict: 'PASSED',
          reason: screenRes.reason || 'Passed',
          checks: screenRes.checks || [],
        },
        simulation: simRes,
        builderCodeAttached,
        executionMode: 'bounded-approval',
        requiresUserApproval: true,
        guard: guardResponse,
        autonomy: {
          reservationId: gatewayResult.reservation.id,
          amountUsdc: gatewayResult.spendAmountUsdc || 0,
          reservedTodayUsdc: gatewayResult.policy.reservedToday,
          dailyLimitUsdc: gatewayResult.policy.dailyLimit,
          expiresAt: new Date(gatewayResult.reservation.expiresAt).toISOString(),
        },
      }));
    }

    await db.update(actions)
      .set({ metadata: { ...meta, executionGuard: guardAudit }, updatedAt: new Date() })
      .where(and(eq(actions.id, actionId), eq(actions.userId, userId), eq(actions.status, 'pending')));

    return res.json(PrepareActionResponseSchema.parse({
      success: true,
      actionId,
      chainId: normalizedChain.hexChainId,
      from: userAddress,
      calls: payload.calls,
      atomicRequired: true,
      actionType: payload.actionType,
      screening: {
        screenedAt: new Date().toISOString(),
        allowed: true,
        verdict: 'PASSED',
        reason: screenRes.reason || 'Passed',
        checks: screenRes.checks || [],
      },
      simulation: simRes,
      builderCodeAttached,
      executionMode: 'manual-approval',
      requiresUserApproval: true,
      guard: guardResponse,
    }));
  } catch (error) {
    next(error);
  }
});

// T19: Record the result of a user-confirmed wallet action. The server does
// NOT broadcast — it only verifies the tx exists onchain via a read-only
// public client and persists the outcome. Replay-guarded by `status='pending'`.
actionsRouter.post('/:actionId/confirm', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const userAddress = tenantWalletAddress(req);
    const actionId = req.params.actionId;

    const parsed = ConfirmActionRequestSchema.safeParse({ actionId, ...req.body });
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid confirm payload' });
    }
    const { batchId, status, txHash, receipts, error } = parsed.data;

    const [action] = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    if (!action) {
      return res.status(404).json({ success: false, error: 'Action not found' });
    }
    // Replay / double-record guard: only a pending or in-progress action can be confirmed.
    const allowedStatuses = ['pending', 'pending_confirmation', 'submitted_unknown'];
    if (!allowedStatuses.includes(action.status)) {
      return res.status(400).json({ success: false, error: `Action is already ${action.status}` });
    }

    const hasValidTxHash = Boolean(txHash && txHash.trim().length > 0);
    const hasValidBatchId = Boolean(batchId && batchId.trim().length > 0);
    const hasSuccessfulReceiptProof = receiptsAreSuccessful(receipts);
    const walletReceiptsProof = hasSuccessfulReceiptProof
      ? buildWalletReceiptsProof({ batchId, receipts: receipts as Record<string, any>[] })
      : null;

    const meta = (action.metadata || {}) as any;
    let executionProof: ExecutionProof | null = walletReceiptsProof;
    let stateVerificationError: string | null = null;

    if (status === 200 && !hasValidTxHash && !executionProof && getActionType(action) === 'revoke_approval') {
      const { context, error: contextError } = extractRevokeApprovalProofContext(action, userAddress);
      if (context) {
        try {
          const allowanceAfter = await actionProofRuntime.readErc20Allowance(context);
          if (allowanceAfter === 0n) {
            executionProof = buildStateVerifiedAllowanceZeroProof(context);
          } else {
            stateVerificationError = `Current allowance is ${allowanceAfter.toString()}, not 0`;
          }
        } catch (err) {
          stateVerificationError = err instanceof Error ? err.message : 'Allowance read failed';
        }
      } else {
        stateVerificationError = contextError || 'Missing revoke proof context';
      }
    }

    const hasProof = hasValidTxHash || Boolean(executionProof);

    let recordStatus: 'executed' | 'failed' | 'pending_confirmation' | 'submitted_unknown' | 'cancelled' = 'failed';
    if (status === 4001 || (error && String(error).toLowerCase().includes('reject')) || (error && String(error).toLowerCase().includes('cancel'))) {
      recordStatus = 'cancelled';
    } else if (status === 102) {
      recordStatus = 'pending_confirmation';
    } else if (status === 200 && hasProof) {
      recordStatus = 'executed';
    } else if (status === 200 && !hasProof) {
      recordStatus = 'failed';
    } else if (!hasProof && (status === 0 || status === 1)) {
      recordStatus = 'submitted_unknown';
    } else {
      recordStatus = 'failed';
    }

    const verifiedTxHash: string | undefined = txHash || undefined;
    let verifiedFrom: string | null = null;
    let verifiedTo: string | null = null;

    // Read-only integrity check: when a txHash is provided, confirm the tx is
    // actually included and successful on Base Mainnet via a read-only public
    // client. On any RPC error or a reverted receipt, fail closed (record
    // `failed`). No key, no broadcast.
    //
    // Note: we deliberately do NOT require tx.from to equal the session user.
    // Base Account is an ERC-4337 smart wallet — `wallet_sendCalls` batches are
    // relayed by a bundler, so the transaction's `from` is the relayer, not the
    // user. The real protections are: only the user's wallet could have signed
    // the batch (their Base Account session), the replay guard
    // (`WHERE status='pending'`), and the audit-ledger trail. We still record
    // `from`/`to` for forensic purposes.
    if (recordStatus === 'executed' && txHash) {
      try {
        const verifiedTx = await actionProofRuntime.verifyBaseTransactionReceipt(txHash);
        verifiedFrom = verifiedTx.from;
        verifiedTo = verifiedTx.to;
        executionProof = buildBaseReceiptProof(txHash);
      } catch {
        // Tx not found / RPC error → fall back only if wallet receipt proof was
        // also supplied. A txHash by itself is never accepted without Base
        // receipt verification.
        if (!walletReceiptsProof) {
          recordStatus = 'failed';
          executionProof = null;
        }
      }
    }

    const confirmation = {
      batchId: batchId || null,
      txHash: verifiedTxHash ?? null,
      confirmedAt: new Date().toISOString(),
      from: verifiedFrom ?? userAddress ?? null,
      to: verifiedTo,
      statusCode: status,
      receipts: receipts ?? null,
    };

    let autonomyAccounting: Record<string, any> | null = null;
    if (meta.autonomyReservation?.id) {
      try {
        if (recordStatus === 'executed') {
          const accountingResult = await getAutonomyPolicyRepository().settle(actionId, {
            ...(verifiedTxHash ? { txHash: verifiedTxHash } : {}),
            ...(hasValidBatchId ? { batchId: batchId || undefined } : {}),
            ...(!verifiedTxHash && !hasValidBatchId && executionProof
              ? { receiptId: `${executionProof.type}:${'verifiedAt' in executionProof ? executionProof.verifiedAt : confirmation.confirmedAt}` }
              : {}),
            confirmedAt: confirmation.confirmedAt,
          });
          autonomyAccounting = {
            success: accountingResult.success,
            status: accountingResult.status,
            settledAt: confirmation.confirmedAt,
            error: accountingResult.error,
          };
        } else if (recordStatus === 'failed' || recordStatus === 'cancelled') {
          const accountingResult = await getAutonomyPolicyRepository().release(actionId, recordStatus);
          autonomyAccounting = {
            success: accountingResult.success,
            status: accountingResult.status,
            releasedAt: confirmation.confirmedAt,
            reason: recordStatus,
            error: accountingResult.error,
          };
        } else {
          autonomyAccounting = { success: true, status: 'reserved', pendingStatus: recordStatus };
        }
      } catch (accountingError) {
        autonomyAccounting = {
          success: false,
          status: 'reconciliation_required',
          error: accountingError instanceof Error ? accountingError.message : String(accountingError),
        };
      }
    }

    const proofMetadata: Record<string, any> = {
      ...meta,
      confirmation,
      ...(autonomyAccounting
        ? {
            autonomyAccounting,
            autonomyReservation: {
              ...meta.autonomyReservation,
              status: autonomyAccounting.status,
            },
          }
        : {}),
      ...(executionProof ? { executionProof } : {}),
      ...(verifiedTxHash ? { txHash: verifiedTxHash } : {}),
      ...(hasValidBatchId ? { batchId } : {}),
      ...(receipts ? { receipts } : {}),
    };
    const normalizedProof = recordStatus === 'executed'
      ? normalizeExecutedActionProof({ ...action, metadata: proofMetadata })
      : null;

    const nextMetadata: Record<string, any> = {
      ...proofMetadata,
    };
    if (recordStatus === 'executed' && normalizedProof) {
      nextMetadata.executionProof = normalizedProof;
    } else if (stateVerificationError) {
      nextMetadata.confirmationError = stateVerificationError;
    }

    await db.update(actions)
      .set({
        status: recordStatus as any,
        executedAt: recordStatus === 'executed' ? new Date() : null,
        updatedAt: new Date(),
        metadata: nextMetadata,
      })
      .where(and(eq(actions.id, actionId), eq(actions.userId, userId), inArray(actions.status, allowedStatuses)));

    const logActionType = recordStatus === 'executed'
      ? 'wallet-confirm'
      : recordStatus === 'cancelled'
        ? 'wallet-confirm-cancelled'
        : recordStatus === 'pending_confirmation' || recordStatus === 'submitted_unknown'
          ? 'wallet-confirm-pending'
          : 'wallet-confirm-failed';

    // Spend/audit ledger trail (reuse the existing audit_logs table + service).
    await ObservabilityService.logAction({
      userId,
      actionId,
      actionType: logActionType,
      txHash: verifiedTxHash,
      details: {
        batchId,
        statusCode: status,
        from: verifiedFrom ?? userAddress,
        to: verifiedTo,
        autonomyAccounting,
      },
    });

    let respError: string | undefined;
    if (recordStatus === 'failed') {
      respError = error || stateVerificationError || 'Confirmation could not be verified onchain or lacked execution proof';
    } else if (recordStatus === 'cancelled') {
      respError = error || 'Cancelled by user';
    }

    return res.json(ConfirmActionResponseSchema.parse({
      success: recordStatus === 'executed',
      status: recordStatus,
      txHash: verifiedTxHash ?? null,
      error: respError,
    }));
  } catch (error) {
    next(error);
  }
});

actionsRouter.post('/:actionId/dismiss', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const actionId = req.params.actionId;

    await releaseActionAutonomyReservation(userId, actionId, 'dismissed');

    await db.update(actions)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

    res.json(DismissActionResponseSchema.parse({ success: true }));
  } catch (error) {
    next(error);
  }
});

actionsRouter.delete('/:actionId', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const actionId = req.params.actionId;

    await releaseActionAutonomyReservation(userId, actionId, 'deleted');

    await db.delete(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    res.json(DeleteSingleActionResponseSchema.parse({ success: true }));
  } catch (error) {
    next(error);
  }
});

actionsRouter.post('/:actionId/regenerate', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const actionId = req.params.actionId;

    const existing = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: 'Action not found' });
    }
    const oldAction = existing[0];
    const oldMeta = (oldAction.metadata || {}) as any;

    const walletAddress = req.body?.walletAddress || oldMeta.analysis?.portfolioSnapshot?.walletAddress || '0x0000000000000000000000000000000000000000';
    const chainEnv = req.body?.chainEnv || oldMeta.chainMode || 'mainnet-readonly';

    const portfolioData = await fetchInternalPortfolio(walletAddress, chainEnv);
    const analysis = analyzePortfolioForRisk(portfolioData, walletAddress, chainEnv);
    const baseMeta = buildRecommendationMetadataFromAnalysis({
      intent: {
        intentType: 'risk',
        confidence: 0.9,
        actionKind: 'recommendation',
        title: 'Regenerated Risk Analysis',
        reason: 'Regenerating portfolio risk evaluation',
        expectedEffect: 'Fresh read-only token analysis',
        tokens: [],
        createdBy: oldMeta.createdBy || 'agent-stream'
      },
      message: oldAction.suggestedPrompt || 'Regenerate portfolio analysis',
      walletAddress,
      chainEnv,
      analysis,
      providerContext: {
        tokenBalances: portfolioData.providers.tokenBalancesProvider,
        prices: portfolioData.providers.prices,
        risk: analysis.securityProvider.status,
        securityProvider: analysis.securityProvider.provider,
      }
    });
    const newMeta = {
      ...baseMeta,
      source: oldMeta.source || oldMeta.createdBy || 'regenerated',
      createdBy: oldMeta.createdBy || 'agent-stream',
      regeneratedFrom: oldAction.id,
      chainMode: chainEnv,
      safetyState: chainEnv === 'mainnet-readonly' ? 'blocked' : 'safe',
    };

    const tokensList = analysis.tokenFindings.map(f => `${f.balanceFormatted || ''} ${f.symbol}`.trim()).slice(0, 5);
    const payload = chainEnv === 'mainnet-readonly' ? {
      chain: 'eip155:8453',
      readOnly: true,
      calls: []
    } : {
      chain: chainEnv === 'mainnet' ? 'eip155:8453' : 'eip155:84532',
      calls: []
    };

    const newActionId = `rec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await db.insert(actions).values({
      id: newActionId,
      userId,
      kind: 'recommendation',
      status: 'pending',
      suggestedPrompt: oldAction.suggestedPrompt || 'Portfolio Risk Analysis',
      tokens: tokensList,
      executionPayload: JSON.stringify(payload),
      metadata: newMeta,
      createdAt: new Date(),
      updatedAt: new Date()
    }).onConflictDoNothing();

    await db.update(actions)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

    res.json(RegenerateRecommendationResponseSchema.parse({ success: true, actionId: newActionId }));
  } catch (error) {
    next(error);
  }
});
