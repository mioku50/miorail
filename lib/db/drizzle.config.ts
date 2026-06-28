import { defineConfig } from 'drizzle-kit';
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

export default defineConfig({
  schema: './schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url,
    ssl: url.includes('neon.tech') ? true : false,
  },
});
