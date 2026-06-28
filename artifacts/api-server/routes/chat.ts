import { Router } from 'express';
import { ChatMessageRequestSchema, ChatHistoryResponseSchema } from '@mioagent/api-zod';
import { Agent } from '@mioagent/agent';
import { MockLlmProvider, OpenAiCompatibleClient, createLlmProvider } from '@mioagent/llm';
import { createToolAggregatorForUser } from '@mioagent/tools';
import { db, chats } from '@mioagent/db';
import { eq, desc } from 'drizzle-orm';
import crypto from 'node:crypto';

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

chatRouter.post('/', async (req, res, next) => {
  try {
    const { message } = ChatMessageRequestSchema.parse(req.body);
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const tools = await createToolAggregatorForUser(userId, process.env.SESSION_SECRET || 'test-secret');

    const llm = createLlmProvider();
    const agent = new Agent({ llmProvider: llm, toolAggregator: tools });

    const userChats = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(desc(chats.updatedAt))
      .limit(1);

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

    if (userChats.length > 0) {
      await db.update(chats)
        .set({ messages: currentMessages, updatedAt: new Date() })
        .where(eq(chats.id, chatId));
    } else {
      await db.insert(chats).values({
        id: chatId,
        userId,
        messages: currentMessages,
        createdAt: new Date(),
        updatedAt: new Date()
      });
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
