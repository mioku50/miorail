import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import dns from 'node:dns';
import { resolveDatabaseConnection } from './testDatabaseGuard';

dns.setDefaultResultOrder('ipv4first');

// Test schema operations must receive TEST_DATABASE_URL explicitly and never
// load the production workspace .env.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: resolve(__dirname, '../../.env') });
}

const connection = resolveDatabaseConnection(process.env, { requireConnection: true });
const url = connection.url!;

export default defineConfig({
  schema: './schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url,
    ssl: url.includes('neon.tech') ? true : false,
  },
});
