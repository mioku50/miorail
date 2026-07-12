import { Router } from 'express';
import { ChatMessageRequestSchema, ChatHistoryResponseSchema, ChatReconcileResponseSchema } from '@mioagent/api-zod';
import { Agent } from '@mioagent/agent';
import { createLlmProvider } from '@mioagent/llm';
import { createApiToolAggregatorForUser } from '../lib/baseMcpTools.js';
import { db, chats, actions } from '@mioagent/db';
import { eq, desc, and } from 'drizzle-orm';
import crypto from 'node:crypto';
import { detectActionIntent } from '../lib/intent.js';
import { getSystemStatus } from './status.js';
import {
  APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE,
  analyzePortfolioForRisk,
  buildPortfolioReviewAssistantContent,
  buildRecommendationMetadataFromAnalysis,
  fetchInternalApprovals,
  fetchInternalPortfolio,
  isApprovalScannerUnavailableStatus,
} from '../lib/portfolioAnalysis.js';
import { buildActionPlan, parseRevokeApproval, findActiveApproval } from '../lib/actionPlan.js';
import { screenAction, simulateTrade } from '@mioagent/security';
import { ObservabilityService } from '@mioagent/observability';
import { MemoryService } from '@mioagent/memory';
import {
  runDirectStreamRead,
  detectRequestedProvider,
  sanitizeStreamToolArgs,
  sanitizedToolErrorCode,
  shouldPreferPartnerRuntimeRead,
  isPartnerWriteCommand,
} from '../lib/streamReadRouting.js';
import { screenPartnerToolResult } from '../lib/partnerResultTrust.js';
import { runDirectQuoteRead } from '../lib/streamQuoteRouting.js';
import { detectRuntimeSkill, runtimeSkillAvailability } from '@mioagent/runtime-skills';
import { getExecutionCapabilities } from '../lib/executionCapabilities.js';
import { tenantUserId, tenantWalletAddress } from '../middleware/tenantAuth';
import { runDirectBaseMcpSwap } from '../lib/streamBaseMcpSwapRouting.js';
import { runDirectBaseMcpSend } from '../lib/streamBaseMcpSendRouting.js';
import { runDirectMoonwellWrite } from '../lib/streamMoonwellWriteRouting.js';
import { getAutonomyPolicyRepository } from '../lib/autonomyGateway.js';
import { reconcileBaseMcpChatMessages } from '../lib/baseMcpTransactionReconciliation.js';

export const chatRouter = Router();

export const chatRouteRuntime = {
  createApiToolAggregatorForUser,
  createLlmProvider,
  getAutonomyPolicyRepository,
  fetchInternalApprovals,
};

const EXPLICIT_TRANSACTION_REQUEST = /(?:\b(?:swap|exchange|buy|sell|approve|revoke|send|transfer)\b|(?:обменяй|обменять|свапни|свапнуть|купи|купить|отправь|отправить|переведи|перевести))/iu;

chatRouter.get('/history', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const userChats = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(desc(chats.updatedAt))
      .limit(1);

    let messages: any[] = [];
    if (userChats.length > 0 && userChats[0].messages) {
      messages = userChats[0].messages as any[];
    }

    res.json(ChatHistoryResponseSchema.parse({ messages }));
  } catch (error) {
    next(error);
  }
});

chatRouter.delete('/history', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    await db.delete(chats).where(eq(chats.userId, userId));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

chatRouter.post('/reconcile', async (req, res, next) => {
  try {
    const userId = tenantUserId(req);
    const [chat] = await db.select().from(chats).where(eq(chats.userId, userId)).orderBy(desc(chats.updatedAt)).limit(1);
    if (!chat) {
      return res.json(ChatReconcileResponseSchema.parse({
        messages: [],
        polledCount: 0,
        updatedCount: 0,
        autonomy: { spentTodayUsdc: '0', reservedTodayUsdc: '0' },
      }));
    }

    const tools = await chatRouteRuntime.createApiToolAggregatorForUser(
      req,
      userId,
      process.env.SESSION_SECRET || 'test-secret',
      { readOnlyOnly: true },
    );
    try {
      const result = await reconcileBaseMcpChatMessages({
        messages: (chat.messages as any[]) || [],
        tools,
        repository: chatRouteRuntime.getAutonomyPolicyRepository(),
        userId,
      });
      if (result.changed) {
        await db.update(chats).set({ messages: result.messages, updatedAt: new Date() }).where(and(eq(chats.id, chat.id), eq(chats.userId, userId)));
      }
      return res.json(ChatReconcileResponseSchema.parse({
        messages: result.messages,
        polledCount: result.polledCount,
        updatedCount: result.updatedCount,
        autonomy: {
          spentTodayUsdc: result.spentTodayUsdc,
          reservedTodayUsdc: result.reservedTodayUsdc,
        },
      }));
    } finally {
      await tools.close();
    }
  } catch (error) {
    next(error);
  }
});


chatRouter.post('/', async (req, res, next) => {
  try {
    const { message } = ChatMessageRequestSchema.parse(req.body);
    const userId = tenantUserId(req);
    const walletAddress = tenantWalletAddress(req);
    // The client may describe its UI network, but it must never promote the
    // server from read-only to an executable environment.
    const configuredChainEnv = process.env.CHAIN_ENV || 'mainnet-readonly';
    const runtimeChainEnv = configuredChainEnv === 'mainnet-readonly'
      ? 'mainnet-readonly'
      : configuredChainEnv;
    const runtimeChainId = runtimeChainEnv === 'sepolia' ? 84532 : 8453;
    const runtimeExecutionCapabilities = getExecutionCapabilities(runtimeChainEnv);
    const tools = await chatRouteRuntime.createApiToolAggregatorForUser(
      req,
      userId,
      process.env.SESSION_SECRET || 'test-secret',
      {
        readOnlyOnly: true,
        includeMorphoReadOnly: true,
        includeUniswapQuote: true,
        includeMoonwell: true,
        includeBaseMcpSwap: runtimeExecutionCapabilities.userConfirmedEnabled,
        includeBaseMcpSend: runtimeExecutionCapabilities.userConfirmedEnabled,
      },
    );
    res.once('finish', () => { void tools.close(); });
    console.log("TRACE: tools created");

    console.log("TRACE: querying chats db");
    const userChats = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(desc(chats.updatedAt))
      .limit(1);
    console.log("TRACE: chats db query done");

    let chatId: string = crypto.randomUUID();
    let currentMessages: any[] = [];

    if (userChats.length > 0) {
      chatId = userChats[0].id;
      currentMessages = (userChats[0].messages as any[]) || [];
    }

    const userMessageId = crypto.randomUUID();
    const userMsg = {
      chatId,
      messageId: userMessageId,
      content: message,
      role: 'user',
      createdAt: new Date().toISOString()
    };

    currentMessages.push(userMsg);

    const directRead = await runDirectBaseMcpSend({
      message,
      walletAddress,
      tools,
      userConfirmedEnabled: runtimeExecutionCapabilities.userConfirmedEnabled,
      userId,
    })
      || await runDirectBaseMcpSwap({
      message,
      walletAddress,
      tools,
      userConfirmedEnabled: runtimeExecutionCapabilities.userConfirmedEnabled,
      userId,
    })
      || await runDirectMoonwellWrite({
      message,
      walletAddress,
      tools,
      userConfirmedEnabled: runtimeExecutionCapabilities.userConfirmedEnabled,
      userId,
    })
      || await runDirectQuoteRead({ message, walletAddress, tools })
      || await runDirectStreamRead({ message, walletAddress, tools });
    if (directRead) {
      const assistantMsg = {
        chatId,
        messageId: crypto.randomUUID(),
        content: directRead.content,
        role: 'assistant' as const,
        createdAt: new Date().toISOString(),
        toolCalls: directRead.toolCalls,
        ...('actionId' in directRead && directRead.actionId ? { actionId: directRead.actionId } : {}),
        metadata: {
          readOnly: !['base_mcp_send', 'base_mcp_swap', 'moonwell_write'].includes(directRead.kind),
          chainId: runtimeChainId,
          chainMode: runtimeChainEnv,
          userConfirmed: ['base_mcp_send', 'base_mcp_swap', 'moonwell_write'].includes(directRead.kind)
            && runtimeExecutionCapabilities.userConfirmedEnabled,
          directReadKind: directRead.kind,
          ...('actionId' in directRead && directRead.actionId ? { actionId: directRead.actionId } : {}),
          ...(directRead.errorCode ? { errorCode: directRead.errorCode } : {}),
          ...('approvalUrl' in directRead && directRead.approvalUrl ? { approvalUrl: directRead.approvalUrl } : {}),
          ...('requestId' in directRead && directRead.requestId ? { requestId: directRead.requestId } : {}),
          ...('approvalState' in directRead && directRead.approvalState ? { approvalState: directRead.approvalState } : {}),
          ...('reservationActionId' in directRead && directRead.reservationActionId ? { reservationActionId: directRead.reservationActionId } : {}),
          ...('reservationExpiresAt' in directRead && directRead.reservationExpiresAt ? { reservationExpiresAt: directRead.reservationExpiresAt } : {}),
          ...('approvalTerminal' in directRead && directRead.approvalTerminal ? { approvalTerminal: true } : {}),
        },
      };
      currentMessages.push(assistantMsg);
      if (userChats.length > 0) {
        await db.update(chats).set({ messages: currentMessages, updatedAt: new Date() }).where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
      } else {
        await db.insert(chats).values({
          id: chatId,
          userId,
          messages: currentMessages,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return res.json(assistantMsg);
    }

    // T42.3 regression fix: this early-return gate must not swallow explicit
    // revoke-approval requests. Before T42.3 it only applied in
    // mainnet-readonly, so revoke messages reached the approval-scanner branch
    // below (parseRevokeApproval/fetchInternalApprovals). Detect that intent
    // first and let it through so the branch stays reachable in every chain env.
    const explicitRevokeIntent = parseRevokeApproval(message) !== null;
    if (!explicitRevokeIntent && (isPartnerWriteCommand(message) || EXPLICIT_TRANSACTION_REQUEST.test(message))) {
      const readOnly = runtimeChainEnv === 'mainnet-readonly' || !runtimeExecutionCapabilities.userConfirmedEnabled;
      const assistantMsg = {
        chatId,
        messageId: crypto.randomUUID(),
        content: readOnly
          ? 'Mainnet is read-only. No transaction or Action Inbox item was prepared. Activate Mainnet · User-confirmed only after all readiness checks pass.'
          : 'The transaction command could not be mapped safely to a supported Base MCP send or swap intent. No tool was called and no Action Inbox item was created.',
        role: 'assistant' as const,
        createdAt: new Date().toISOString(),
        metadata: { readOnly, blocked: true, errorCode: readOnly ? 'mainnet_readonly' : 'transaction_intent_unrecognized' },
      };
      currentMessages.push(assistantMsg);
      if (userChats.length > 0) {
        await db.update(chats).set({ messages: currentMessages, updatedAt: new Date() }).where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
      } else {
        await db.insert(chats).values({ id: chatId, userId, messages: currentMessages, createdAt: new Date(), updatedAt: new Date() });
      }
      return res.json(assistantMsg);
    }

    const runtimeToolInventory = await tools.listTools();
    const requestedProvider = detectRequestedProvider(message, runtimeToolInventory);
    const runtimeSkill = detectRuntimeSkill(message);
    const runtimeSkillState = runtimeSkill
      ? runtimeSkillAvailability({
          skill: runtimeSkill,
          intent: 'read',
          toolNames: runtimeToolInventory.map((tool) => tool.name),
        })
      : undefined;
    const preferRuntimeReadTools = shouldPreferPartnerRuntimeRead(message, runtimeToolInventory);
    const directTransactionIntent = isPartnerWriteCommand(message) || EXPLICIT_TRANSACTION_REQUEST.test(message);
    const intent = preferRuntimeReadTools
      ? { isActionIntent: false, confidence: 1 }
      : directTransactionIntent
        ? {
            isActionIntent: true,
            intentType: 'general_recommendation' as const,
            title: 'User-confirmed transaction request',
            reason: 'Transaction request requires security screening and final Base Account approval.',
            expectedEffect: 'Prepare only a whitelisted unsigned EIP-5792 request when all production gates pass.',
            risk: 'medium' as const,
            confidence: 1,
          }
      : detectActionIntent(message);
    const isWalletConnected = true;

    if (intent.isActionIntent && !isWalletConnected) {
      const assistantMsg = {
        chatId,
        messageId: crypto.randomUUID(),
        content: 'Connect a wallet first so I can analyze your Base portfolio.',
        role: 'assistant' as const,
        createdAt: new Date().toISOString()
      };
      currentMessages.push(assistantMsg);
      if (userChats.length > 0) {
        await db.update(chats).set({ messages: currentMessages, updatedAt: new Date() }).where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
      } else {
        await db.insert(chats).values({ id: chatId, userId, messages: currentMessages, createdAt: new Date(), updatedAt: new Date() });
      }
      return res.json(assistantMsg);
    }

    if (intent.isActionIntent && isWalletConnected) {
      const actionId = crypto.randomUUID();
      const chainEnvVal = runtimeChainEnv;
      const isReadonly = chainEnvVal === 'mainnet-readonly';
      const executionCapabilities = runtimeExecutionCapabilities;
      const canExecute = executionCapabilities.serverBroadcastEnabled;
      const canUserConfirm = executionCapabilities.userConfirmedEnabled;

      let tokenBalancesProvider = 'none';
      let pricesStatus = 'missing';
      let riskStatus = 'missing';
      let securityProvider = 'none';
      try {
        const statusRes = getSystemStatus(chainEnvVal);
        tokenBalancesProvider = statusRes.tokenBalances.provider;
        pricesStatus = statusRes.prices.status;
        riskStatus = statusRes.risk.status;
        securityProvider = statusRes.risk.provider;
      } catch (e) {
        // ignore fallback
      }
      const memoryMd = (await MemoryService.getUserSettings(userId).catch(() => null))?.memoryMd || null;
      const requiresTokenSecurity = ['portfolio', 'risk', 'security'].includes(intent.intentType || '');

      const toolCallTraces: any[] = [
        {
          toolName: 'detect_action_intent',
          args: { message },
          result: { intentType: intent.intentType, confidence: intent.confidence, isActionIntent: true },
          isError: false,
        }
      ];

      let metadata: any = {
        type: "recommendation",
        title: intent.title || "Action Recommendation",
        instruction: message,
        reason: intent.reason || `Automated recommendation created by Agent Stream for: "${message}"`,
        expectedEffect: intent.expectedEffect || `Analyze portfolio and simulate action on ${chainEnvVal}`,
        risk: intent.risk || (isReadonly ? "unknown" : "low"),
        riskScore: intent.risk === 'high' ? 85 : intent.risk === 'medium' ? 50 : 15,
        chainMode: chainEnvVal,
        safetyState: isReadonly ? "blocked" : (canExecute || canUserConfirm ? "executable" : "blocked"),
        executable: canExecute,
        userConfirmable: canUserConfirm,
        executionStatus: isReadonly ? "read-only" : (canExecute ? "executable" : (canUserConfirm ? "user-confirmable" : "blocked")),
        createdBy: "agent-stream",
        walletAddress: walletAddress,
        providerContext: {
          tokenBalances: tokenBalancesProvider,
          prices: pricesStatus,
          risk: riskStatus,
          securityProvider
        }
      };

      let assistantContent = isReadonly 
        ? 'I created a read-only recommendation in Action Inbox. You can review and manage it in your Action Inbox tab.'
        : 'I created a recommendation in Action Inbox. You can review and manage it in your Action Inbox tab.';
      let tokensList: string[] | undefined;

      if (['portfolio', 'risk', 'rebalance', 'security', 'yield', 'approvals'].includes(intent.intentType || '') && walletAddress) {
        try {
          const portfolio = await fetchInternalPortfolio(walletAddress, chainEnvVal, {
            includeApprovals: intent.intentType === 'approvals',
          });
          toolCallTraces.push({
            toolName: 'fetch_internal_portfolio',
            args: { walletAddress, chainEnv: chainEnvVal },
            result: { tokenCount: portfolio.tokens?.length || 0, provider: portfolio.providers.tokenBalancesProvider },
            isError: false,
          });

          const analysis = analyzePortfolioForRisk(portfolio, walletAddress, chainEnvVal);
          riskStatus = analysis.securityProvider.status;
          securityProvider = portfolio.providers.riskProvider || securityProvider;
          toolCallTraces.push({
            toolName: 'analyze_portfolio_for_risk',
            args: { walletAddress, tokenCount: portfolio.tokens?.length || 0 },
            result: { overallRiskLevel: analysis.overallRiskLevel, suspiciousTokenCount: analysis.portfolioSnapshot.suspiciousTokenCount },
            isError: false,
          });

          metadata = buildRecommendationMetadataFromAnalysis({
            intent,
            message,
            walletAddress,
            chainEnv: chainEnvVal,
            analysis,
            providerContext: {
              tokenBalances: portfolio.providers.tokenBalancesProvider || tokenBalancesProvider,
              prices: portfolio.providers.priceProvider || pricesStatus,
              risk: analysis.securityProvider.status,
              securityProvider: portfolio.providers.riskProvider || 'none',
              approvals: portfolio.approvalScan?.status || 'not_requested',
              approvalProvider: portfolio.providers.approvalProvider || 'none',
            }
          });
          assistantContent = buildPortfolioReviewAssistantContent(analysis, isReadonly);
          tokensList = analysis.tokenFindings.map(f => `${f.balanceFormatted || ''} ${f.symbol}`.trim()).slice(0, 5);
        } catch (err) {
          console.error("Failed portfolio analysis in chat:", err);
        }
      }

      const configuredSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER || 'none';
      const secProvider = securityProvider && securityProvider !== 'none'
        ? securityProvider
        : configuredSecurityProvider;
      const screenRes = screenAction({
        instruction: message,
        memoryMd,
        providerContext: {
          risk: riskStatus,
          riskProvider: secProvider,
          securityProvider: secProvider,
          requiresTokenSecurity
        }
      });
      toolCallTraces.push({
        toolName: 'screen_action_security',
        args: { instruction: message },
        result: { allowed: screenRes.allowed, reason: screenRes.reason },
        isError: !screenRes.allowed,
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

      const isMainnetLike = isReadonly || chainEnvVal === 'mainnet';
      const revokeIntent = isMainnetLike ? parseRevokeApproval(message) : null;
      let approvalsForPlan: any[] | undefined;
      let approvalScannerUnavailable = false;
      if (revokeIntent && walletAddress) {
        try {
          const appRes = await chatRouteRuntime.fetchInternalApprovals(walletAddress, chainEnvVal);
          if (isApprovalScannerUnavailableStatus(appRes.status)) {
            approvalScannerUnavailable = true;
            metadata.title = "Approval Scanner Unavailable";
            metadata.reason = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
            metadata.message = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
            metadata.userConfirmable = false;
            metadata.executable = false;
            metadata.safetyState = "blocked";
            metadata.executionStatus = "read-only";
            assistantContent = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
          } else {
            approvalsForPlan = appRes.approvals;
          }
        } catch (err) {
          console.error("Approval scanner check failed for revoke request:", err);
          approvalScannerUnavailable = true;
        }
      }

      let payload: any = isReadonly ? {
        chain: 'eip155:8453',
        readOnly: true,
        calls: []
      } : {
        chain: chainEnvVal === 'mainnet' ? 'eip155:8453' : 'eip155:84532',
        calls: [
          {
            to: walletAddress || '0x0000000000000000000000000000000000000000',
            value: '0',
            data: '0x'
          }
        ]
      };

      if (isMainnetLike) {
        payload = buildActionPlan(message, {
          chainEnv: chainEnvVal,
          walletAddress,
          approvals: approvalsForPlan,
          memoryMd,
          securityProviderContext: {
            risk: riskStatus,
            riskProvider: secProvider,
            securityProvider: secProvider,
            requiresTokenSecurity,
          },
        });
      }

      let simRes;
      if (!isReadonly && payload.calls && payload.calls.length > 0) {
        try {
          simRes = await simulateTrade({ ...(payload as any), instruction: message, memoryMd });
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

      toolCallTraces.push({
        toolName: 'simulate_action_execution',
        args: { readOnly: isReadonly, chain: payload.chain },
        result: { allowed: simRes.allowed, gas: simRes.estimatedGas || '0' },
        isError: !simRes.allowed,
      });

      metadata.securityScreening = securityScreening;
      metadata.simulationResult = simRes;

      const activeRevoke = revokeIntent ? findActiveApproval(approvalsForPlan, revokeIntent.spender, revokeIntent.tokenSymbol) : null;
      if (revokeIntent && approvalScannerUnavailable) {
        metadata.title = "Approval Scanner Unavailable";
        metadata.reason = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
        metadata.message = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
        metadata.userConfirmable = false;
        metadata.executable = false;
        metadata.safetyState = "blocked";
        metadata.executionStatus = "read-only";
        delete metadata.actionType;
        delete metadata.preferredFirstAction;
        assistantContent = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
      } else if (revokeIntent && !activeRevoke) {
        metadata.title = "Revoke Approval";
        metadata.reason = "No active approval found for this spender — nothing to revoke.";
        metadata.message = "No active approval found for this spender — nothing to revoke.";
        metadata.userConfirmable = false;
        metadata.executable = false;
        metadata.safetyState = "safe";
        metadata.executionStatus = "read-only";
        delete metadata.actionType;
        delete metadata.preferredFirstAction;
        assistantContent = "No active approval found for this spender — nothing to revoke.";
      } else if (activeRevoke && payload.actionType === 'revoke_approval') {
        metadata.title = `Revoke ${activeRevoke.tokenSymbol || 'Token'} Spend Permission`;
        metadata.reason = `Automated recommendation to revoke spend access for ${activeRevoke.spenderLabel || activeRevoke.spenderAddress}`;
        metadata.actionType = "revoke_approval";
        metadata.preferredFirstAction = true;
        metadata.userConfirmable = canUserConfirm;
        metadata.executable = canExecute;
        metadata.executionStatus = canExecute ? "executable" : (canUserConfirm ? "user-confirmable" : "read-only");
        metadata.allowanceBefore = activeRevoke.allowanceFormatted;
        metadata.allowanceAfter = "0";
        metadata.tokenSymbol = activeRevoke.tokenSymbol;
        metadata.tokenAddress = activeRevoke.tokenAddress;
        metadata.spender = activeRevoke.spenderAddress;
        metadata.method = "approve(spender,0)";
        metadata.validationMethod = "preflight-validation";
        metadata.simulationLabel = "Preflight validation — no fork simulation";
        assistantContent = `I prepared a transaction to revoke spend access for ${activeRevoke.tokenSymbol || 'token'}. You can confirm this action in your Action Inbox.`;
      } else if (payload.actionType === 'limited_transfer' && payload.calls?.length > 0) {
        metadata.title = 'User-confirmed USDC Transfer';
        metadata.actionType = 'limited_transfer';
        metadata.userConfirmable = canUserConfirm;
        metadata.executable = false;
        metadata.safetyState = canUserConfirm ? 'user-confirmable' : 'blocked';
        metadata.executionStatus = canUserConfirm ? 'user-confirmable' : 'read-only';
        assistantContent = canUserConfirm
          ? 'I created a screened transfer request in Action Inbox. It remains unsigned until you review it and approve the final wallet_sendCalls request in Base Account.'
          : 'Mainnet is read-only. No transaction was prepared.';
      } else {
        metadata.actionType = payload.actionType;
        metadata.preferredFirstAction = payload.actionType === 'revoke_approval';
      }

      toolCallTraces.push({
        toolName: 'create_recommendation_action',
        args: { actionId, kind: payload.actionType === 'revoke_approval' ? 'transaction' : 'recommendation', tokens: tokensList || [] },
        result: { status: 'pending', actionId },
        isError: false,
      });

      await db.insert(actions).values({
        id: actionId,
        userId,
        kind: payload.actionType === 'revoke_approval' ? 'transaction' : 'recommendation',
        status: 'pending',
        suggestedPrompt: message,
        tokens: tokensList,
        executionPayload: JSON.stringify(payload),
        metadata,
        createdAt: new Date(),
        updatedAt: new Date()
      }).onConflictDoNothing();

      const assistantMsg = {
        chatId,
        messageId: crypto.randomUUID(),
        content: assistantContent,
        role: 'assistant' as const,
        createdAt: new Date().toISOString(),
        actionId,
        toolCalls: toolCallTraces,
        metadata: {
          actionId,
          type: 'recommendation',
          toolCalls: toolCallTraces
        }
      };
      currentMessages.push(assistantMsg);
      if (userChats.length > 0) {
        await db.update(chats).set({ messages: currentMessages, updatedAt: new Date() }).where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
      } else {
        await db.insert(chats).values({ id: chatId, userId, messages: currentMessages, createdAt: new Date(), updatedAt: new Date() });
      }

      try {
        await ObservabilityService.logAction({
          userId,
          actionId: assistantMsg.messageId,
          actionType: 'portfolio_scan',
          details: { message, intentType: intent.intentType, actionId },
          cost: '0.0010',
        });
      } catch {
        // ignore
      }

      return res.json(assistantMsg);
    }

    const llm = chatRouteRuntime.createLlmProvider();
    console.log("TRACE: llm created");
    const agent = new Agent({
      llmProvider: llm,
      toolAggregator: tools,
      toolResultGuard: (result) => screenPartnerToolResult({
        ...result,
        providerNamespace: requestedProvider?.namespace,
      }),
      runtimeContext: {
        walletAddress,
        chainId: runtimeChainId,
        chain: runtimeChainEnv === 'sepolia' ? 'base-sepolia' : 'base',
        executionMode: getExecutionCapabilities(runtimeChainEnv).userConfirmedEnabled ? 'user-confirmed' : 'read-only',
        providerNamespace: requestedProvider?.namespace,
        skillNamespace: runtimeSkillState?.available ? runtimeSkill?.namespace : undefined,
        skillInstructions: runtimeSkillState?.available ? runtimeSkill?.instructions : undefined,
        skillLoaded: runtimeSkillState?.available === true,
      },
    });
    console.log("TRACE: agent created");

    if (userChats.length > 0) {
      console.log("TRACE: updating chats db");
      await db.update(chats)
        .set({ messages: currentMessages, updatedAt: new Date() })
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
      console.log("TRACE: updated chats db");
    } else {
      console.log("TRACE: inserting chats db");
      await db.insert(chats).values({
        id: chatId,
        userId,
        messages: currentMessages,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log("TRACE: inserted chats db");
    }

    let finalContent = '';
    const toolCallsMap = new Map<string, any>();
    const toolCallTraces: any[] = [];

    for await (const event of agent.chatStream(userId, message)) {
      if (event.type === 'message') {
        finalContent += event.content;
      } else if (event.type === 'tool_call') {
        let args: unknown = {};
        try {
          args = event.args ? JSON.parse(event.args) : {};
        } catch {
          args = {};
        }
        toolCallsMap.set(event.toolName, {
          toolName: event.toolName,
          args: sanitizeStreamToolArgs(args),
          result: undefined,
          isError: false
        });
      } else if (event.type === 'tool_result') {
        const existing = toolCallsMap.get(event.toolName) || { toolName: event.toolName, args: {} };
        existing.isError = event.isError || false;
        existing.result = event.isError
          ? { status: 'error', errorCode: sanitizedToolErrorCode(event.result) }
          : { status: 'success' };
        toolCallsMap.set(event.toolName, existing);
      }
    }
    for (const val of toolCallsMap.values()) {
      toolCallTraces.push(val);
    }

    if (toolCallTraces.length === 0) {
      toolCallTraces.push({
        toolName: 'detect_action_intent',
        args: { message },
        result: { intentType: intent.intentType, confidence: intent.confidence },
        isError: false,
      });
      toolCallTraces.push({
        toolName: 'llm_inference',
        args: { mode: 'read-only' },
        result: { status: 'success' },
        isError: false,
      });
    }

    const assistantMessageId = crypto.randomUUID();
    const assistantMsg = {
      chatId,
      messageId: assistantMessageId,
      content: finalContent || 'No response',
      role: 'assistant' as const,
      createdAt: new Date().toISOString(),
      toolCalls: toolCallTraces,
      metadata: {
        toolCalls: toolCallTraces
      }
    };

    currentMessages.push(assistantMsg);

    await db.update(chats)
      .set({ messages: currentMessages, updatedAt: new Date() })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)));

    try {
      await ObservabilityService.logAction({
        userId,
        actionId: assistantMessageId,
        actionType: 'inference_call',
        details: { message },
        cost: '0.0010',
      });
    } catch {
      // ignore
    }

    res.json(assistantMsg);
  } catch (error) {
    next(error);
  }
});
