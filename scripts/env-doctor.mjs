#!/usr/bin/env node
/**
 * env-doctor.mjs — MioAgent environment health check.
 *
 * Checks the root .env for:
 *   (a) Duplicate keys
 *   (b) Missing required variables for the current CHAIN_ENV
 *   (c) CHAIN_ENV vs VITE_CHAIN_ENV desync (if artifacts/interface/.env exists)
 *
 * Prints variable names and status only — values are NEVER printed.
 * Exit code: 1 if duplicates or missing required vars found; 0 on warnings only.
 *
 * Usage: node scripts/env-doctor.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');
const INTERFACE_ENV_PATH = resolve(ROOT, 'artifacts', 'interface', '.env');

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return { vars: {}, duplicates: [], lines: [] };

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const vars = {};
  const seen = {};
  const duplicates = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    if (seen[key]) {
      duplicates.push(key);
    }
    seen[key] = true;
    vars[key] = value; // last value wins (dotenv default behaviour)
  }

  return { vars, duplicates, lines };
}

function isSet(value) {
  return value !== undefined && value !== '' && value !== null;
}

// ── Required variable definitions per CHAIN_ENV ───────────────────────────────

const REQUIRED_ALWAYS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'LLM_PROVIDER',
  'CHAIN_ENV',
];

const REQUIRED_BY_MODE = {
  sepolia: [
    ...REQUIRED_ALWAYS,
    'BASE_SEPOLIA_RPC_URL',
    'LLM_BASE_URL',
    'LLM_API_KEY',
    'LLM_MODEL',
  ],
  'mainnet-readonly': [
    ...REQUIRED_ALWAYS,
    'BASE_MAINNET_RPC_URL',
    'MORALIS_API_KEY',      // required because TOKEN_BALANCES_PROVIDER=moralis
    'TOKEN_BALANCES_PROVIDER',
    'PRICE_PROVIDER',
    'TOKEN_SECURITY_PROVIDER',
    'APPROVAL_PROVIDER',
  ],
  mainnet: [
    ...REQUIRED_ALWAYS,
    'BASE_MAINNET_RPC_URL',
    'MORALIS_API_KEY',
    'TOKEN_BALANCES_PROVIDER',
    'PRICE_PROVIDER',
    'TOKEN_SECURITY_PROVIDER',
    'APPROVAL_PROVIDER',
    'MAINNET_EXECUTION_ENABLED',
    'MCP_SERVER_URL',
    'X402_FACILITATOR_URL',
  ],
};

// ── Main ──────────────────────────────────────────────────────────────────────

let hasErrors = false;
const warnings = [];

console.log('=== env-doctor: MioAgent environment check ===\n');

// Check .env exists
if (!existsSync(ENV_PATH)) {
  console.error('ERROR: .env not found at', ENV_PATH);
  console.error('  → Copy .env.example to .env and fill in values.');
  process.exit(1);
}

const { vars, duplicates } = parseEnvFile(ENV_PATH);

// (a) Duplicate keys
if (duplicates.length > 0) {
  hasErrors = true;
  console.error('ERRORS — Duplicate keys in .env (dotenv behaviour: last value wins):');
  for (const key of duplicates) {
    console.error(`  DUPLICATE: ${key}`);
  }
  console.error('  → Remove duplicate entries to avoid silent misconfiguration.\n');
} else {
  console.log('OK  No duplicate keys\n');
}

// (b) Missing required vars for current CHAIN_ENV
const chainEnv = vars['CHAIN_ENV'] || 'sepolia';
const validModes = Object.keys(REQUIRED_BY_MODE);

if (!validModes.includes(chainEnv)) {
  warnings.push(`CHAIN_ENV='${chainEnv}' is not a recognised mode (expected: ${validModes.join(' | ')})`);
}

const required = REQUIRED_BY_MODE[chainEnv] || REQUIRED_ALWAYS;
const missing = required.filter((key) => !isSet(vars[key]));

console.log(`Checking required variables for CHAIN_ENV='${chainEnv}':`);
if (missing.length > 0) {
  hasErrors = true;
  console.error('ERRORS — Missing required variables:');
  for (const key of missing) {
    console.error(`  MISSING: ${key}`);
  }
  console.error('  → Set these in .env before starting the server.\n');
} else {
  console.log('OK  All required variables are set\n');
}

// Extra check: if APPROVAL_PROVIDER=moralis, MORALIS_API_KEY must be set
const approvalProvider = vars['APPROVAL_PROVIDER'];
if (approvalProvider === 'moralis' && !isSet(vars['MORALIS_API_KEY'])) {
  hasErrors = true;
  console.error('ERROR: APPROVAL_PROVIDER=moralis but MORALIS_API_KEY is not set.\n');
}

// Extra check: MAINNET_EXECUTION_ENABLED guard
if (chainEnv === 'mainnet-readonly' && vars['MAINNET_EXECUTION_ENABLED'] === 'true') {
  warnings.push('MAINNET_EXECUTION_ENABLED=true has no effect in mainnet-readonly mode (execution is blocked regardless).');
}

// (c) CHAIN_ENV vs VITE_CHAIN_ENV desync
if (existsSync(INTERFACE_ENV_PATH)) {
  const { vars: frontendVars } = parseEnvFile(INTERFACE_ENV_PATH);
  const viteChainEnv = frontendVars['VITE_CHAIN_ENV'];

  console.log('Checking frontend/backend CHAIN_ENV sync (artifacts/interface/.env):');
  if (!isSet(viteChainEnv)) {
    warnings.push('VITE_CHAIN_ENV is not set in artifacts/interface/.env — frontend will use its build default.');
    console.warn('  WARN: VITE_CHAIN_ENV not set in artifacts/interface/.env');
  } else if (viteChainEnv !== chainEnv) {
    warnings.push(`CHAIN_ENV desync: backend CHAIN_ENV='${chainEnv}' but VITE_CHAIN_ENV='${viteChainEnv}'. Rebuild frontend after changing mode.`);
    console.warn(`  WARN: CHAIN_ENV desync — backend='${chainEnv}' frontend='${viteChainEnv}'`);
    console.warn('    → Rebuild frontend: pnpm --filter interface build');
  } else {
    console.log(`OK  CHAIN_ENV and VITE_CHAIN_ENV both='${chainEnv}' in sync\n`);
  }
} else {
  warnings.push('artifacts/interface/.env not found — VITE_CHAIN_ENV not checked. Run: cp artifacts/interface/.env.example artifacts/interface/.env');
  console.log('INFO: artifacts/interface/.env not found — skipping frontend sync check\n');
}

// ── Summary ───────────────────────────────────────────────────────────────────

if (warnings.length > 0) {
  console.log('WARNINGS (exit 0):');
  for (const w of warnings) {
    console.log(`  WARN: ${w}`);
  }
  console.log();
}

if (hasErrors) {
  console.error('env-doctor: FAILED — fix errors above before starting the server.');
  process.exit(1);
} else {
  console.log('env-doctor: OK — environment looks healthy.');
  process.exit(0);
}
