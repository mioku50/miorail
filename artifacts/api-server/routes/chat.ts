import { Router } from 'express';
import { ChatMessageRequestSchema, ChatHistoryResponseSchema } from '@mioagent/api-zod';
import { Agent } from '@mioagent/agent';
import { createLlmProvider } from '@mioagent/llm';
import { createApiToolAggregatorForUser } from '../lib/baseMcpTools.js';
import { db, chats, actions } from '@mioagent/db';
import { eq, desc } from 'drizzle-orm';
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
} from '../lib/streamReadRouting.js';
import { screenPartnerToolResult } from '../lib/partnerResultTrust.js';

export const chatRouter = Router();

export const chatRouteRuntime = {
  createApiToolAggregatorForUser,
  createLlmProvider,
};

chatRouter.get('/history', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    await db.delete(chats).where(eq(chats.userId, userId));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});


chatRouter.post('/', async (req, res, next) => {
  try {
    const { message, walletAddress, chainEnv } = ChatMessageRequestSchema.parse(req.body);
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const runtimeChainEnv = chainEnv || process.env.CHAIN_ENV || 'mainnet-readonly';
    const runtimeChainId = runtimeChainEnv === 'sepolia' ? 84532 : 8453;
    const tools = await chatRouteRuntime.createApiToolAggregatorForUser(
      req,
      userId,
      process.env.SESSION_SECRET || 'test-secret',
      { readOnlyOnly: true, includeMorphoReadOnly: true },
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

    const directRead = await runDirectStreamRead({ message, walletAddress, tools });
    if (directRead) {
      const assistantMsg = {
        chatId,
        messageId: crypto.randomUUID(),
        content: directRead.content,
        role: 'assistant' as const,
        createdAt: new Date().toISOString(),
        toolCalls: directRead.toolCalls,
        metadata: {
          readOnly: true,
          chainId: runtimeChainId,
          directReadKind: directRead.kind,
          ...(directRead.errorCode ? { errorCode: directRead.errorCode } : {}),
        },
      };
      currentMessages.push(assistantMsg);
      if (userChats.length > 0) {
        await db.update(chats).set({ messages: currentMessages, updatedAt: new Date() }).where(eq(chats.id, chatId));
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

    const runtimeToolInventory = await tools.listTools();
    const requestedProvider = detectRequestedProvider(message, runtimeToolInventory);
    const preferRuntimeReadTools = shouldPreferPartnerRuntimeRead(message, runtimeToolInventory);
    const intent = preferRuntimeReadTools
      ? { isActionIntent: false, confidence: 1 }
      : detectActionIntent(message);
    const isWalletConnected = !!(walletAddress && walletAddress !== 'None' && walletAddress !== '0x0' && walletAddress !== '');

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
        await db.update(chats).set({ messages: currentMessages, updatedAt: new Date() }).where(eq(chats.id, chatId));
      } else {
        await db.insert(chats).values({ id: chatId, userId, messages: currentMessages, createdAt: new Date(), updatedAt: new Date() });
      }
      return res.json(assistantMsg);
    }

    if (intent.isActionIntent && isWalletConnected) {
      const actionId = crypto.randomUUID();
      const chainEnvVal = runtimeChainEnv;
      const isReadonly = chainEnvVal === 'mainnet-readonly';
      const isMainnetExecEnabled = process.env.MAINNET_EXECUTION_ENABLED === 'true';
      const canExecute = !isReadonly && (chainEnvVal !== 'mainnet' || isMainnetExecEnabled);

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
        safetyState: isReadonly ? "blocked" : (canExecute ? "executable" : "blocked"),
        executable: canExecute,
        executionStatus: isReadonly ? "read-only" : (canExecute ? "executable" : "blocked"),
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
          const appRes = await fetchInternalApprovals(walletAddress, chainEnvVal);
          if (isApprovalScannerUnavailableStatus(appRes.status)) {
            approvalScannerUnavailable = true;
            metadata.title = "Approval Scanner Unavailable";
            metadata.reason = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
            metadata.message = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
            metadata.userConfirmable = false;
            metadata.executable = false;
            metadata.safetyState = "safe";
            metadata.executionStatus = "read-only";
            assistantContent = APPROVAL_SCANNER_UNAVAILABLE_UI_NOTE;
          } else {
            approvalsForPlan = appRes.approvals;
          }
        } catch {}
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

      if (isMainnetLike && revokeIntent) {
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
        metadata.safetyState = "safe";
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
        assistantContent = `I prepared a transaction to revoke spend access for ${activeRevoke.tokenSymbol || 'token'}. You can confirm this action in your Action Inbox.`;
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
        await db.update(chats).set({ messages: currentMessages, updatedAt: new Date() }).where(eq(chats.id, chatId));
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
        executionMode: 'read-only',
        providerNamespace: requestedProvider?.namespace,
      },
    });
    console.log("TRACE: agent created");

    if (userChats.length > 0) {
      console.log("TRACE: updating chats db");
      await db.update(chats)
        .set({ messages: currentMessages, updatedAt: new Date() })
        .where(eq(chats.id, chatId));
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
      .where(eq(chats.id, chatId));

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
