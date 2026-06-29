import test from 'node:test';
import assert from 'node:assert';
import { getUserSettings, updateUserSettings, setEncryptedKey, getDecryptedKey, injectMemoryIntoPrompt } from '../src/index';
import { db, userSettings, users } from '@mioagent/db';
import { eq } from 'drizzle-orm';

test('Settings and Memory functions', async (t) => {
  const userId = 'test-user-' + Date.now();
  const sessionSecret = '0123456789abcdef0123456789abcdef';

  // Insert user first because userSettings.userId has a foreign key to users.id
  await db.insert(users).values({ id: userId }).onConflictDoNothing();

  // Cleanup settings before tests
  await db.delete(userSettings).where(eq(userSettings.userId, userId));

  await t.test('getUserSettings should return null initially', async () => {
    const settings = await getUserSettings(userId);
    assert.strictEqual(settings, null);
  });

  await t.test('updateUserSettings should create new settings', async () => {
    const data = { memoryMd: 'Test Memory', model: 'gpt-4o' };
    const settings = await updateUserSettings(userId, data);
    assert.strictEqual(settings.userId, userId);
    assert.strictEqual(settings.memoryMd, 'Test Memory');
    assert.strictEqual(settings.model, 'gpt-4o');
  });

  await t.test('injectMemoryIntoPrompt should append memory to prompt', async () => {
    const prompt = 'Hello assistant.';
    const injected = await injectMemoryIntoPrompt(prompt, userId);
    assert.strictEqual(injected, 'Hello assistant.\n\nUser Memory context:\nTest Memory');
  });

  await t.test('setEncryptedKey and getDecryptedKey should store and retrieve key', async () => {
    await setEncryptedKey(userId, 'openai', 'sk-secret-key', sessionSecret);
    const decrypted = await getDecryptedKey(userId, 'openai', sessionSecret);
    assert.strictEqual(decrypted, 'sk-secret-key');

    const settings = await getUserSettings(userId);
    assert.ok(settings?.encryptedKeys);
    assert.notStrictEqual((settings.encryptedKeys as Record<string, unknown>)['openai'], 'sk-secret-key'); // should be encrypted
  });

  // Cleanup
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

test('Cleanup DB', async () => {
  const { closeDb } = await import('@mioagent/db');
  await closeDb();
});
