import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../../.env.example') });

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let attempt = 0;
  while (attempt < 5) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const options = { ...init, signal: controller.signal };
      const res = await fetch(input, options);
      clearTimeout(timeout);
      return res;
    } catch (e: any) {
      attempt++;
      console.warn(`[Neon DB] fetch attempt ${attempt} failed: ${e.message}`);
      if (attempt >= 5) throw e;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('Unreachable');
};

import { neonConfig } from '@neondatabase/serverless';
neonConfig.fetchFunction = customFetch;
const sql = neon(url);

export const db = drizzle(sql, { schema });
export const client = async (strings: TemplateStringsArray, ...values: any[]) => {
  return await sql(strings, ...values);
};
export const closeDb = async () => {};
export * from './schema';
export { auditLogs } from './schema';
