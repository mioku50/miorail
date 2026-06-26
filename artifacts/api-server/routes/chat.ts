import { Router } from 'express';
import { ChatMessageRequestSchema } from '@mioagent/api-zod';
import { Agent } from '@mioagent/agent';
import { MockLlmProvider } from '@mioagent/llm';
import { createToolAggregatorForUser } from '@mioagent/tools';

export const chatRouter = Router();

// Dummy instances for now
const llm = new MockLlmProvider('This is a mock response from the agent.');
// Tools and agent instantiated per request

chatRouter.post('/', async (req, res, next) => {
  try {
    const { message } = ChatMessageRequestSchema.parse(req.body);
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const tools = await createToolAggregatorForUser(userId, process.env.SESSION_SECRET || 'test-secret');
    const agent = new Agent({ llmProvider: llm, toolAggregator: tools });

    // We will buffer the stream into a single response for now to fulfill the basic API contract
    let finalContent = '';
    for await (const event of agent.chatStream(userId, message)) {
      if (event.type === 'message') {
        finalContent += event.content;
      }
    }

    res.json({
      chatId: 'mock-chat-id',
      messageId: 'mock-msg-id',
      content: finalContent || 'No response',
      role: 'assistant',
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});
