import { db, userSettings } from '@mioagent/db';
import { deriveKey, encrypt, decrypt } from '@mioagent/crypto';
import { eq } from 'drizzle-orm';

export interface UpdateSettingsData {
  memoryMd?: string;
  model?: string;
  protocolToggles?: Record<string, boolean>;
  encryptedKeys: encryptedKeys as Record<string, string>
}

export async function getUserSettings(userId: string) {
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  return settings || null;
}

export async function updateUserSettings(userId: string, data: UpdateSettingsData) {
  const [updated] = await db.insert(userSettings).values({
    userId,
    ...data,
  }).onConflictDoUpdate({
    target: userSettings.userId,
    set: {
      ...data,
      updatedAt: new Date(),
    }
  }).returning();
  return updated;
}

export async function setEncryptedKey(userId: string, keyName: string, keyValue: string, sessionSecret: string) {
  const derivedKey = deriveKey(sessionSecret, 'settings-key-salt');
  const encryptedValue = encrypt(keyValue, derivedKey);

  const settings = await getUserSettings(userId);
  const encryptedKeys = (settings?.encryptedKeys as Record<string, string>) || {};
  encryptedKeys[keyName] = encryptedValue;

  return updateUserSettings(userId, {
    memoryMd: settings?.memoryMd || undefined,
    model: settings?.model || undefined,
    protocolToggles: settings?.protocolToggles as Record<string, boolean> | undefined,
    encryptedKeys: encryptedKeys as Record<string, unknown>
  });
}

export async function getDecryptedKey(userId: string, keyName: string, sessionSecret: string): Promise<string | null> {
  const settings = await getUserSettings(userId);
  if (!settings || !settings.encryptedKeys) return null;

  const encryptedKeys = settings.encryptedKeys as Record<string, string>;
  const encryptedValue = encryptedKeys[keyName];

  if (!encryptedValue) return null;

  const derivedKey = deriveKey(sessionSecret, 'settings-key-salt');
  return decrypt(encryptedValue, derivedKey);
}

export async function injectMemoryIntoPrompt(prompt: string, userId: string): Promise<string> {
  const settings = await getUserSettings(userId);
  const memoryMd = settings?.memoryMd;

  if (!memoryMd) return prompt;

  return `${prompt}\n\nUser Memory context:\n${memoryMd}`;
}
