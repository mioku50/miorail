import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

// Load .env relative to the workspace root
dotenv.config({ path: resolve(__dirname, '../.env') });
dotenv.config({ path: resolve(__dirname, '../.env.example') }); // fallback

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set in environment variables');
  process.exit(1);
}

async function probe() {
  const isNeon = url!.includes('neon.tech');
  const sql = postgres(url!, {
    ssl: isNeon ? 'require' : undefined,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 20,
    max: 5
  });

  try {
    const result = await sql`select current_database(), now()`;
    console.log('✅ Successfully connected to database.');
    console.log(`Database: ${result[0].current_database}`);
    console.log(`Time: ${result[0].now}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to connect to database.');
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

probe();
