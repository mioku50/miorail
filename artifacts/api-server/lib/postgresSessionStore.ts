import session, { type SessionData } from 'express-session';
import { client, databaseConnectionInfo } from '@mioagent/db';
import { logger } from '@mioagent/utils';

type StoreCallback = (error?: unknown) => void;
type GetCallback = (error: unknown, session?: session.SessionData | null) => void;

function unavailableV1(): Error {
  return new Error('session_store_unavailable');
}

function expiryV1(data: SessionData): Date {
  const expires = data.cookie?.expires;
  if (expires) {
    const parsed = new Date(expires);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  const maxAge = data.cookie?.maxAge;
  return new Date(Date.now() + (typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000));
}

/**
 * Minimal Postgres express-session store.
 *
 * The signed cookie still contains only the opaque session id. The session
 * body is stored server-side and upserted atomically, so a deployment no
 * longer signs every wallet out. All callbacks deliberately receive generic
 * errors: callers must never surface a database URL to a browser.
 */
export class PostgresSessionStoreV1 extends session.Store {
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private cleaning: Promise<void> | null = null;

  constructor(private readonly sql = client) {
    super();
  }

  /** One sweep at a time; no session bodies or database details enter errors. */
  cleanupExpired(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    const run = async () => {
      try { await this.sql`DELETE FROM web_sessions WHERE expires_at < now()`; }
      catch { throw unavailableV1(); }
    };
    this.cleaning = run().finally(() => { this.cleaning = null; });
    return this.cleaning;
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch(() => {
        logger.warn('Expired browser sessions cleanup failed', { code: 'session_cleanup_failed' });
      });
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  get(sid: string, callback: GetCallback): void {
    void (async () => {
      const rows = await this.sql`
        SELECT session
        FROM web_sessions
        WHERE sid = ${sid} AND expires_at > now()
        LIMIT 1`;
      if (rows.length === 0) {
        callback(null, null);
        return;
      }
      const value = rows[0]?.session;
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      callback(null, parsed as SessionData);
    })().catch(() => callback(unavailableV1()));
  }

  set(sid: string, data: SessionData, callback?: StoreCallback): void {
    void this.sql`
      INSERT INTO web_sessions (sid, session, expires_at, updated_at)
      VALUES (${sid}, ${JSON.stringify(data)}::jsonb, ${expiryV1(data)}, now())
      ON CONFLICT (sid) DO UPDATE SET
        session = EXCLUDED.session,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()`
      .then(() => callback?.())
      .catch(() => callback?.(unavailableV1()));
  }

  destroy(sid: string, callback?: StoreCallback): void {
    void this.sql`DELETE FROM web_sessions WHERE sid = ${sid}`
      .then(() => callback?.())
      .catch(() => callback?.(unavailableV1()));
  }

  touch(sid: string, data: SessionData, callback?: StoreCallback): void {
    void this.sql`
      UPDATE web_sessions
      SET expires_at = ${expiryV1(data)}, updated_at = now()
      WHERE sid = ${sid}`
      .then(() => callback?.())
      .catch(() => callback?.(unavailableV1()));
  }
}

export function sessionStoreV1(env: NodeJS.ProcessEnv = process.env): session.Store {
  if (env.NODE_ENV === 'test') return new session.MemoryStore();
  if (databaseConnectionInfo.configured) {
    const store = new PostgresSessionStoreV1();
    if (env.NODE_ENV === 'production') store.startCleanup();
    return store;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required for persistent production sessions');
  }
  return new session.MemoryStore();
}
