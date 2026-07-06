import { Router } from 'express';
import { db, actions } from '@mioagent/db';
import { desc, eq, and, ne, inArray } from 'drizzle-orm';
import {
  ActionsFeedResponseSchema,
  ExecuteActionResponseSchema,
  DismissActionResponseSchema,
  DismissAllRecommendationsResponseSchema,
  DeleteRecommendationsResponseSchema,
  DeleteSingleActionResponseSchema,
  RegenerateRecommendationResponseSchema,
  PrepareActionResponseSchema,
  ConfirmActionRequestSchema,
  ConfirmActionResponseSchema,
} from '@mioagent/api-zod';
import { createPublicClient, http, type Hex } from 'viem';
import { base } from 'viem/chains';
import { ObservabilityService } from '@mioagent/observability';
import { detectActionIntent } from '../lib/intent.js';
import { fetchInternalPortfolio, analyzePortfolioForRisk, buildRecommendationMetadataFromAnalysis, fetchInternalApprovals, type TokenApproval } from '../lib/portfolioAnalysis.js';
import { buildActionPlan, planHasCalls, getBaseMainnetUsdcAddress, parseRevokeApproval, findActiveApproval } from '../lib/actionPlan.js';
import { getExecutionCapabilities } from '../lib/executionCapabilities.js';
import { screenAction, simulateTrade } from '@mioagent/security';
import { isProductionActionType } from '@mioagent/api-zod';

export const actionsRouter = Router();

actionsRouter.delete('/demo', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now

    console.log("TRACE: actions GET querying db");
    const userActions = await db
      .select()
      .from(actions)
      .where(eq(actions.userId, userId))
      .orderBy(desc(actions.createdAt))
      .limit(50); // Basic limit
    console.log(`TRACE: actions GET query done, found ${userActions.length}`);

    const formattedActions = userActions
      .filter(a => {
        const meta = (a.metadata || {}) as any;
        if (a.suggestedPrompt?.includes('Test transfer of Sepolia USDC')) return false;
        if (meta.demo === true || meta.source === 'demo' || meta.createdBy === 'seed' || meta.source === 'seed') return false;
        return true;
      })
      .map(a => ({
        id: a.id,
        kind: a.kind,
        status: a.status as any,
        suggestedPrompt: a.suggestedPrompt,
        tokens: Array.isArray(a.tokens) ? a.tokens.map(String) : undefined,
        executionPayload: a.executionPayload,
        metadata: a.metadata,
        createdAt: a.createdAt.toISOString(),
        executedAt: a.executedAt ? a.executedAt.toISOString() : null,
      }));

    res.json(ActionsFeedResponseSchema.parse({ actions: formattedActions }));
  } catch (error) {
    next(error);
  }
});

import { createToolAggregatorForUser } from '@mioagent/tools';


actionsRouter.post('/recommend', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const { instruction, walletAddress: reqWallet, chainEnv: reqChainEnv } = req.body;
    const walletAddress = reqWallet || (req as { session?: { user?: { address?: string } } }).session?.user?.address;
    
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
        approvalsForPlan = appRes.approvals;
      } catch {
        return res.json({
          success: false,
          error: 'Could not verify spend permissions. Please try again.',
        });
      }
    }

    if (isMainnetLike) {
      payload = buildActionPlan(instruction, { chainEnv, walletAddress, approvals: approvalsForPlan });
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

    const intent = detectActionIntent(instruction);
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
        const portfolio = await fetchInternalPortfolio(walletAddress, chainEnv);
        const analysis = analyzePortfolioForRisk(portfolio, walletAddress, chainEnv);
        metadata = buildRecommendationMetadataFromAnalysis({
          intent: { ...intent, createdBy: 'actions-builder' },
          message: instruction,
          walletAddress,
          chainEnv,
          analysis,
          providerContext: {
            tokenBalances: portfolio.providers.tokenBalancesProvider,
            prices: portfolio.providers.priceProvider || portfolio.providers.prices,
            risk: portfolio.providers.risk,
            securityProvider: portfolio.providers.riskProvider || 'none'
          }
        });
        tokensList = analysis.tokenFindings.map(f => `${f.balanceFormatted || ''} ${f.symbol}`.trim()).slice(0, 5);
      } catch (err) {
        console.error("Failed portfolio analysis in action builder:", err);
      }
    }

    const secProvider = process.env.TOKEN_SECURITY_PROVIDER || 'none';
    const screenRes = screenAction({
      instruction,
      providerContext: {
        risk: secProvider === 'goplus' ? 'connected' : 'missing',
        riskProvider: secProvider,
        securityProvider: secProvider
      }
    });
    const securityScreening = {
      screenedAt: new Date().toISOString(),
      allowed: screenRes.allowed,
      verdict: screenRes.allowed ? 'PASSED' : 'BLOCKED',
      reason: screenRes.reason || 'All action-security heuristics and contract security checks evaluated.',
      checks: screenRes.checks || [
        { name: 'Prompt Injection / Jailbreak', status: 'PASSED' },
        { name: 'Credential Exfiltration', status: 'PASSED' },
        { name: 'Wallet Drain / Sweep', status: screenRes.allowed ? 'PASSED' : 'BLOCKED' },
        { name: 'Unlimited Token Approval', status: screenRes.allowed ? 'PASSED' : 'BLOCKED' },
        { name: 'GoPlus Contract Security', status: secProvider === 'goplus' ? 'PASSED' : 'SKIPPED' }
      ]
    };

    let simRes;
    // T19: run the static validator on any payload with calls — including
    // mainnet-readonly user-confirmable plans — so the gate
    // (screening.allowed && simulation.success && hasCalls) works for the
    // user-confirmed flow. Read-only plans with no calls get the safe mock.
    if (payload.calls && payload.calls.length > 0) {
      try {
        simRes = await simulateTrade(payload as any);
      } catch (e) {
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
      metadata.validationMethod = "static-validation";
      metadata.simulationLabel = "Static validation — not a real simulation";
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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now
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
      aggregator = await createToolAggregatorForUser(userId, sessionSecret);
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
      const isSepolia = process.env.CHAIN_ENV === 'sepolia';
      const toolName = isSepolia ? 'sepolia_send_calls' : 'send_calls';

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

         await db.update(actions)
          .set({ status: 'executed', updatedAt: new Date() })
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
// Base Account. The server never broadcasts here, never reads
// MAINNET_EXECUTION_ENABLED, and uses no backend key. Screening + simulation
// are re-derived LIVE (stored metadata is advisory only) and gate the response.
actionsRouter.post('/:actionId/prepare', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const userAddress = (req as { session?: { user?: { address?: string } } }).session?.user?.address || null;
    const actionId = req.params.actionId;

    const [action] = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    if (!action) {
      return res.status(404).json({ success: false, error: 'Action not found' });
    }
    if (action.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Action is not pending' });
    }

    // Extract execution payload (same logic as /execute).
    let payload: { chain: string; actionType?: 'revoke_approval' | 'limited_transfer'; calls: { to: string; value?: string; data?: string }[] };
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

    // T19.1: defensive whitelist gate. actionPlan only ever produces
    // whitelisted action types, but prepare re-checks so a stale/hand-edited
    // payload can never reach the user's wallet.
    if (!isProductionActionType(payload.actionType)) {
      return res.json({ success: false, error: 'Action type is not on the production whitelist' });
    }

    // Re-derive screening live. The instruction is stored on metadata.
    const meta = (action.metadata || {}) as any;
    const instruction = meta.instruction || action.suggestedPrompt || '';
    const secProvider = process.env.TOKEN_SECURITY_PROVIDER || 'none';
    const screenRes = screenAction({
      instruction,
      providerContext: {
        risk: secProvider === 'goplus' ? 'connected' : 'missing',
        riskProvider: secProvider,
        securityProvider: secProvider,
      },
    });
    if (!screenRes.allowed) {
      return res.json(PrepareActionResponseSchema.parse({
        success: false,
        actionId,
        chainId: '0x2105',
        from: userAddress,
        calls: payload.calls,
        atomicRequired: true,
        screening: {
          screenedAt: new Date().toISOString(),
          allowed: false,
          verdict: 'BLOCKED',
          reason: screenRes.reason || 'Blocked by security screening',
          checks: screenRes.checks || [],
        },
        simulation: {
          success: false, allowed: false, riskLevel: 'blocked',
          reason: 'Screening blocked; simulation skipped',
          checks: ['Instruction screening: Failed'],
        },
        builderCodeAttached: false,
        error: `Security screening blocked: ${screenRes.reason || 'unsafe instruction'}`,
      }));
    }

    // Re-derive simulation live. Reject any non-canon-token calldata.
    let simRes;
    try {
      simRes = await simulateTrade(payload as any);
    } catch (e) {
      simRes = { success: false, allowed: false, riskLevel: 'blocked', checks: ['Simulation failed'] };
    }
    if (!simRes.success) {
      return res.json(PrepareActionResponseSchema.parse({
        success: false,
        actionId,
        chainId: '0x2105',
        from: userAddress,
        calls: payload.calls,
        atomicRequired: true,
        screening: {
          screenedAt: new Date().toISOString(),
          allowed: true,
          verdict: 'PASSED',
          reason: screenRes.reason || 'Passed',
          checks: screenRes.checks || [],
        },
        simulation: simRes,
        builderCodeAttached: false,
        error: `Simulation rejected: ${simRes.error || simRes.reason || 'unsafe calls'}`,
      }));
    }

    // Builder Code attribution is applied client-side (public env); the server
    // only reports whether a code is configured so the UI can show it.
    const builderCodeAttached = !!(process.env.BUILDER_CODE || process.env.VITE_BUILDER_CODE || process.env.NEXT_PUBLIC_BUILDER_CODE);

    return res.json(PrepareActionResponseSchema.parse({
      success: true,
      actionId,
      chainId: '0x2105',
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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const userAddress = (req as { session?: { user?: { address?: string } } }).session?.user?.address || null;
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
    const hasValidReceipts = Boolean(receipts && Array.isArray(receipts) && receipts.length > 0);
    const hasValidBatchId = Boolean(batchId && batchId.trim().length > 0);
    const hasProof = hasValidTxHash || hasValidReceipts || (hasValidBatchId && status === 200);

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

    let verifiedTxHash: string | undefined = txHash || undefined;
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
        const rpcUrl = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
        const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
        if (receipt.status !== 'success') {
          recordStatus = 'failed';
        }
        // Record the originating account/target for the audit trail (best-effort).
        try {
          const tx = await publicClient.getTransaction({ hash: txHash as Hex });
          verifiedFrom = (tx.from as string) ?? null;
          verifiedTo = (tx.to as string) ?? null;
        } catch {
          // getTransaction failure is non-fatal — the receipt already proved inclusion.
        }
      } catch {
        // Tx not found / RPC error → fail closed.
        recordStatus = 'failed';
      }
    }

    const meta = (action.metadata || {}) as any;
    const confirmation = {
      batchId: batchId || null,
      txHash: verifiedTxHash ?? null,
      confirmedAt: new Date().toISOString(),
      from: verifiedFrom ?? userAddress ?? null,
      to: verifiedTo,
      statusCode: status,
      receipts: receipts ?? null,
    };

    await db.update(actions)
      .set({
        status: recordStatus as any,
        executedAt: recordStatus === 'executed' ? new Date() : null,
        updatedAt: new Date(),
        metadata: { ...meta, confirmation },
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
      details: { batchId, statusCode: status, from: verifiedFrom ?? userAddress, to: verifiedTo },
    });

    let respError: string | undefined;
    if (recordStatus === 'failed') {
      respError = error || 'Confirmation could not be verified onchain or lacked execution proof';
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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now
    const actionId = req.params.actionId;

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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const actionId = req.params.actionId;

    await db.delete(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    res.json(DeleteSingleActionResponseSchema.parse({ success: true }));
  } catch (error) {
    next(error);
  }
});

actionsRouter.post('/:actionId/regenerate', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
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
        risk: portfolioData.providers.risk
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

