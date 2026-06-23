import { db, userSettings } from '@mioagent/db';
import { eq } from 'drizzle-orm';

export interface UserSettingsData {
  memoryMd: string | null;
  model: string | null;
  protocolToggles: Record<string, boolean> | null;
  encryptedKeys: Record<string, unknown> | null;
}

export class MemoryService {
  /**
   * Retrieves the user's settings and markdown memory.
   */
  static async getUserSettings(userId: string): Promise<UserSettingsData | null> {
    const records = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
    if (records.length === 0) return null;

    const record = records[0];
    return {
      memoryMd: record.memoryMd,
      model: record.model,
      protocolToggles: record.protocolToggles as Record<string, boolean> | null,
      encryptedKeys: record.encryptedKeys as Record<string, unknown> | null,
    };
  }

  /**
   * Updates or creates the user's settings.
   */
  static async updateUserSettings(userId: string, data: Partial<UserSettingsData>): Promise<void> {
    const existing = await this.getUserSettings(userId);
    if (existing) {
      await db
        .update(userSettings)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(userSettings.userId, userId));
    } else {
      await db.insert(userSettings).values({
        userId,
        ...data,
      });
    }
  }

  /**
   * Constructs a system prompt including the user's markdown memory.
   */
  static async buildSystemPrompt(userId: string, basePrompt: string): Promise<string> {
    const settings = await this.getUserSettings(userId);
    const memory = settings?.memoryMd;

    if (memory && memory.trim().length > 0) {
      return `${basePrompt}\n\n<user_memory>\n${memory.trim()}\n</user_memory>`;
    }

    return basePrompt;
  }
}
