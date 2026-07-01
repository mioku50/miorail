import { Router } from 'express';
import { ChatMessageRequestSchema, ChatHistoryResponseSchema } from '@mioagent/api-zod';
import { Agent } from '@mioagent/agent';
import { createLlmProvider } from '@mioagent/llm';
import { createToolAggregatorForUser } from '@mioagent/tools';
import { db, chats, actions } from '@mioagent/db';
import { eq, desc } from 'drizzle-orm';
import crypto from 'node:crypto';
import { detectActionIntent } from '../lib/intent.js';
import { getSystemStatus } from './status.js';

export const chatRouter = Router();

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
    const tools = await createToolAggregatorForUser(userId, process.env.SESSION_SECRET || 'test-secret');
    console.log("TRACE: tools created");

    const llm = createLlmProvider();
    console.log("TRACE: llm created");
    const agent = new Agent({ llmProvider: llm, toolAggregator: tools });
    console.log("TRACE: agent created");

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

    const intent = detectActionIntent(message);
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
      const chainEnvVal = chainEnv || process.env.CHAIN_ENV || 'sepolia';
      const isReadonly = chainEnvVal === 'mainnet-readonly';
      const isMainnetExecEnabled = process.env.MAINNET_EXECUTION_ENABLED === 'true';
      const canExecute = !isReadonly && (chainEnvVal !== 'mainnet' || isMainnetExecEnabled);

      let tokenBalancesProvider = 'none';
      let pricesStatus = 'missing';
      let riskStatus = 'missing';
      try {
        const statusRes = getSystemStatus(chainEnvVal);
        tokenBalancesProvider = statusRes.tokenBalances.provider;
        pricesStatus = statusRes.prices.status;
        riskStatus = statusRes.risk.status;
      } catch (e) {
        // ignore fallback
      }

      const metadata = {
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
          risk: riskStatus
        }
      };

      const payload = isReadonly ? {
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

      await db.insert(actions).values({
        id: actionId,
        userId,
        kind: 'recommendation',
        status: 'pending',
        suggestedPrompt: message,
        executionPayload: JSON.stringify(payload),
        metadata,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const assistantMsg = {
        chatId,
        messageId: crypto.randomUUID(),
        content: isReadonly 
          ? 'I created a read-only recommendation in Action Inbox. You can review and manage it in your Action Inbox tab.'
          : 'I created a recommendation in Action Inbox. You can review and manage it in your Action Inbox tab.',
        role: 'assistant' as const,
        createdAt: new Date().toISOString(),
        actionId,
        metadata: {
          actionId,
          type: 'recommendation'
        }
      };
      currentMessages.push(assistantMsg);
      if (userChats.length > 0) {
        await db.update(chats).set({ messages: currentMessages, updatedAt: new Date() }).where(eq(chats.id, chatId));
      } else {
        await db.insert(chats).values({ id: chatId, userId, messages: currentMessages, createdAt: new Date(), updatedAt: new Date() });
      }
      return res.json(assistantMsg);
    }

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
    for await (const event of agent.chatStream(userId, message)) {
      if (event.type === 'message') {
        finalContent += event.content;
      }
    }

    const assistantMessageId = crypto.randomUUID();
    const assistantMsg = {
      chatId,
      messageId: assistantMessageId,
      content: finalContent || 'No response',
      role: 'assistant',
      createdAt: new Date().toISOString()
    };

    currentMessages.push(assistantMsg);

    await db.update(chats)
      .set({ messages: currentMessages, updatedAt: new Date() })
      .where(eq(chats.id, chatId));

    res.json(assistantMsg);
  } catch (error) {
    next(error);
  }
});
