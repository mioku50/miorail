import { Router } from 'express';
import { ChatMessageRequestSchema } from '@mioagent/api-zod';
import { Agent } from '@mioagent/agent';
import { MockLlmProvider } from '@mioagent/llm';
import { ToolAggregator } from '@mioagent/tools';

export const chatRouter = Router();

// Dummy instances for now
const llm = new MockLlmProvider('This is a mock response from the agent.');
const tools = new ToolAggregator();
const agent = new Agent({ llmProvider: llm, toolAggregator: tools });

chatRouter.post('/', async (req, res, next) => {
  try {
    const { message } = ChatMessageRequestSchema.parse(req.body);
    const userId = (req as any).session?.user?.id || 'default-user';

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
