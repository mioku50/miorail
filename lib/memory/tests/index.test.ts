import { test, mock } from 'node:test';
import assert from 'node:assert';
import { MemoryService } from '../src/index';

test('MemoryService.buildSystemPrompt handles user without memory', async () => {
  const basePrompt = 'You are a helpful assistant.';
  const userId = 'non-existent-user';

  // Mock getUserSettings
  mock.method(MemoryService, 'getUserSettings', async () => null);

  const prompt = await MemoryService.buildSystemPrompt(userId, basePrompt);
  assert.strictEqual(prompt, basePrompt);
});

test('MemoryService.buildSystemPrompt handles user with memory', async () => {
  const basePrompt = 'You are a helpful assistant.';
  const userId = 'user-with-memory';

  // Mock getUserSettings
  mock.method(MemoryService, 'getUserSettings', async () => ({
      memoryMd: 'User likes red color.',
      model: null,
      protocolToggles: null,
      encryptedKeys: null
  }));

  const prompt = await MemoryService.buildSystemPrompt(userId, basePrompt);
  assert.strictEqual(prompt, `${basePrompt}\n\n<user_memory>\nUser likes red color.\n</user_memory>`);
});

test('MemoryService.buildSystemPrompt handles user with empty or whitespace memory', async () => {
  const basePrompt = 'You are a helpful assistant.';
  const userId = 'user-with-empty-memory';

  // Mock getUserSettings
  mock.method(MemoryService, 'getUserSettings', async () => ({
      memoryMd: '   \n  ',
      model: null,
      protocolToggles: null,
      encryptedKeys: null
  }));

  const prompt = await MemoryService.buildSystemPrompt(userId, basePrompt);
  assert.strictEqual(prompt, basePrompt);
});
