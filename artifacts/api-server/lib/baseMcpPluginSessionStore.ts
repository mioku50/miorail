import { client } from '@mioagent/db';
import { decrypt, deriveKey, encrypt } from '@mioagent/crypto';

const PROVIDER = 'virtuals';
const SESSION_SALT = 'base-mcp-plugin-session-virtuals-v1';

export type VirtualsPluginSessionV1 =
  | {
      stage: 'awaiting_signature';
      walletAddress: `0x${string}`;
      message: string;
      receiptId: string;
      expiresAt: string;
    }
  | {
      stage: 'authenticated';
      walletAddress: `0x${string}`;
      token: string;
      refreshToken: string | null;
      expiresAt: string;
    };

function key(sessionSecret: string): Buffer {
  return deriveKey(sessionSecret, SESSION_SALT);
}

function encrypted(value: VirtualsPluginSessionV1, sessionSecret: string): string {
  return encrypt(JSON.stringify(value), key(sessionSecret));
}

function decrypted(value: string, sessionSecret: string): VirtualsPluginSessionV1 {
  return JSON.parse(decrypt(value, key(sessionSecret))) as VirtualsPluginSessionV1;
}

export interface BaseMcpPluginSessionStoreV1 {
  available(): Promise<boolean>;
  save(input: { userId: string; sessionSecret: string; session: VirtualsPluginSessionV1 }): Promise<void>;
  load(input: { userId: string; sessionSecret: string }): Promise<VirtualsPluginSessionV1 | null>;
  clear(userId: string): Promise<void>;
}

export class PostgresBaseMcpPluginSessionStoreV1 implements BaseMcpPluginSessionStoreV1 {
  async available(): Promise<boolean> {
    try {
      const rows = await client`SELECT to_regclass('public.base_mcp_plugin_sessions') AS name`;
      return Boolean(rows[0]?.name);
    } catch {
      return false;
    }
  }

  async save(input: { userId: string; sessionSecret: string; session: VirtualsPluginSessionV1 }): Promise<void> {
    const now = new Date().toISOString();
    await client`
      INSERT INTO base_mcp_plugin_sessions (
        user_id, provider, wallet_address, encrypted_session, expires_at, created_at, updated_at
      ) VALUES (
        ${input.userId}, ${PROVIDER}, ${input.session.walletAddress.toLowerCase()},
        ${encrypted(input.session, input.sessionSecret)}, ${input.session.expiresAt}::timestamptz,
        ${now}::timestamptz, ${now}::timestamptz
      )
      ON CONFLICT (user_id, provider) DO UPDATE
      SET wallet_address = EXCLUDED.wallet_address,
          encrypted_session = EXCLUDED.encrypted_session,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at
    `;
  }

  async load(input: { userId: string; sessionSecret: string }): Promise<VirtualsPluginSessionV1 | null> {
    const rows = await client`
      SELECT encrypted_session, expires_at
      FROM base_mcp_plugin_sessions
      WHERE user_id = ${input.userId} AND provider = ${PROVIDER}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      await this.clear(input.userId);
      return null;
    }
    try {
      return decrypted(String(row.encrypted_session), input.sessionSecret);
    } catch {
      await this.clear(input.userId);
      return null;
    }
  }

  async clear(userId: string): Promise<void> {
    await client`DELETE FROM base_mcp_plugin_sessions WHERE user_id = ${userId} AND provider = ${PROVIDER}`;
  }
}

export class InMemoryBaseMcpPluginSessionStoreV1 implements BaseMcpPluginSessionStoreV1 {
  availableValue = true;
  private values = new Map<string, VirtualsPluginSessionV1>();

  async available(): Promise<boolean> { return this.availableValue; }
  async save(input: { userId: string; sessionSecret: string; session: VirtualsPluginSessionV1 }): Promise<void> {
    this.values.set(input.userId, structuredClone(input.session));
  }
  async load(input: { userId: string; sessionSecret: string }): Promise<VirtualsPluginSessionV1 | null> {
    const value = this.values.get(input.userId);
    if (!value || Date.parse(value.expiresAt) <= Date.now()) return null;
    return structuredClone(value);
  }
  async clear(userId: string): Promise<void> { this.values.delete(userId); }
}
