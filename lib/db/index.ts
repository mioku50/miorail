import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

// Load .env relative to the workspace root
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../../.env.example') }); // fallback

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

// Global client to prevent multiple instances during hot reloading or tests
const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const conn = globalForDb.conn ?? postgres(url, {
  ssl: url.includes('neon.tech') ? 'require' : undefined,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 20,
  max: 5
});
if (process.env.NODE_ENV !== 'production') globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
export const client = conn;
export * from './schema';
export { auditLogs } from './schema';
