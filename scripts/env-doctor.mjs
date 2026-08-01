#!/usr/bin/env node
/**
 * env-doctor.mjs — MioAgent environment health check.
 *
 * Checks the root .env for:
 *   (a) Duplicate keys
 *   (b) Missing required variables for the current CHAIN_ENV
 *   (c) CHAIN_ENV vs VITE_CHAIN_ENV desync (if artifacts/interface/.env exists)
 *   (d) T67X-A1: paid intelligence enabled without a settlement path
 *   (e) T67X-B2: mainnet execution enabled without a Builder Code
 *
 * Prints variable names and status only — values are NEVER printed, with one
 * exception: a Builder Code is a PUBLIC base.dev identifier, and naming which
 * key it came from is how an operator resolves a conflict.
 *
 * Exit code: 1 on duplicates, missing required vars, or a failed production
 * gate; 0 on warnings only.
 *
 * Usage: pnpm env:doctor [-- --probe]
 *   --probe  additionally calls the facilitator's /supported endpoint. Off by
 *            default: a deployment check that fails because CI has no egress is
 *            worse than no check at all.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builderCodeAdviceV1, resolveBuilderCodeV1 } from '../lib/route-domain/src/builder-code.ts';
import { x402ConfigFromEnv, x402StatusFromEnv } from '../lib/x402-gateway/src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// ENV_DOCTOR_ENV_PATH checks a CANDIDATE .env — the one about to be deployed —
// without installing it first. The tests use it for the same reason: the
// contract this script has with a deploy is its exit code, and the only way to
// pin an exit code is to run the real script against a real file.
const ENV_PATH = process.env.ENV_DOCTOR_ENV_PATH
  ? resolve(process.env.ENV_DOCTOR_ENV_PATH)
  : resolve(ROOT, '.env');
const INTERFACE_ENV_PATH = process.env.ENV_DOCTOR_ENV_PATH
  ? ''
  : resolve(ROOT, 'artifacts', 'interface', '.env');

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
// `pnpm env:doctor -- --probe` forwards the separator; skip it rather than
// making the documented invocation fail on its own documentation.
const cliArgs = process.argv.slice(2).filter((argument) => argument !== '--');
const probeRequested = cliArgs.includes('--probe');
for (const argument of cliArgs) {
  if (argument !== '--probe') {
    console.error(`env-doctor: unrecognised argument: ${argument}`);
    process.exit(2);
  }
}

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
if (INTERFACE_ENV_PATH && existsSync(INTERFACE_ENV_PATH)) {
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

// ── (d) T67X-A1: paid intelligence requires a settlement path ────────────────
//
// `X402_FACILITATOR_URL` alone is not one. A URL with no working authorization
// produces a 402 the user signs and a settlement that then fails — the worst
// possible ordering, because the signature is already out of their wallet.
//
// The static check runs always; it needs no network and is the actual gate.
// `--probe` adds the live call for an operator who wants confirmation.

const paidIntelligenceOn = String(vars['MIORAIL_PAID_INTELLIGENCE'] || '').trim().toLowerCase() === 'true';
const x402 = x402ConfigFromEnv(vars);

console.log('Checking paid intelligence settlement readiness:');
if (!paidIntelligenceOn) {
  console.log('OK  MIORAIL_PAID_INTELLIGENCE is off — settlement is not required\n');
} else if (x402.settleReady) {
  console.log(`OK  settlement path configured (auth via ${x402.authSource})\n`);
} else {
  hasErrors = true;
  console.error('ERROR: MIORAIL_PAID_INTELLIGENCE=true but x402 settlement is not ready.');
  console.error(`  reason: ${x402.settleBlockedReason || 'unknown'}`);
  if (x402.missingConfig.length > 0) {
    console.error(`  missing: ${x402.missingConfig.join(', ')}`);
  }
  console.error('  → Set X402_FACILITATOR_AUTH_TOKEN, or a complete CDP_API_KEY_ID + CDP_API_KEY_SECRET pair.');
  console.error('  → The API will still start and free route comparison still works;');
  console.error('    paid intelligence readiness reports "blocked" until this is fixed.\n');
}

if (probeRequested && paidIntelligenceOn) {
  console.log('Probing the facilitator (--probe):');
  try {
    const probed = await x402StatusFromEnv(vars);
    if (probed.settleReady) {
      console.log(`OK  facilitator reachable — ${probed.supportedKindsCount ?? 0} supported kind(s)\n`);
    } else {
      hasErrors = true;
      console.error(`ERROR: facilitator probe failed — status=${probed.status} reason=${probed.settleBlockedReason || probed.errorCode || 'unknown'}\n`);
    }
  } catch (error) {
    // A probe that could not run is not a configuration verdict.
    warnings.push(`facilitator probe could not complete: ${error instanceof Error ? error.message : String(error)}`);
    console.warn('  WARN: probe could not complete; the static check above still applies\n');
  }
}

// ── (e) T67X-B2: mainnet execution requires a Builder Code ───────────────────
//
// Attribution failure is silent — no error, no revert, just activity credited
// to nobody. Before the first batch goes out is the only moment it is visible.
// Read-only capabilities are never gated on this.

const executionEnabled =
  (chainEnv === 'mainnet' && vars['MAINNET_EXECUTION_ENABLED'] === 'true') ||
  chainEnv === 'sepolia';
const builderCode = resolveBuilderCodeV1(vars);
const builderAdvice = builderCodeAdviceV1(builderCode);

console.log('Checking Builder Code attribution:');
if (builderCode.status === 'resolved') {
  console.log(`OK  Builder Code resolved from ${builderCode.key}`);
  if (builderAdvice) console.log(`  NOTE: ${builderAdvice}`);
  console.log();
} else if (chainEnv === 'mainnet' && executionEnabled) {
  hasErrors = true;
  console.error('ERROR: mainnet execution is enabled but no usable Builder Code is configured.');
  console.error(`  → ${builderAdvice}`);
  console.error('  → Execution readiness is blocked; quotes, comparison, evidence, scoring,');
  console.error('    B20 inspection, history and public proofs are unaffected.\n');
} else {
  // Testnet and read-only deployments have no attribution to lose.
  warnings.push(builderAdvice);
  console.warn(`  WARN: ${builderAdvice}\n`);
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
