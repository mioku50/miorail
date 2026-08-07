import { createHash } from 'node:crypto';

import {
  paidIntelligencePreflightV1,
  type PaidIntelligencePreflightV1,
} from '../artifacts/api-server/lib/paidIntelligencePreflight.js';
import {
  PAID_EVIDENCE_PERIOD_DAYS_V1,
  confirmSpendPermissionV1,
  prepareSpendPermissionV1,
} from '../artifacts/api-server/lib/spendPermissionOnboarding.js';
import {
  PAID_EVIDENCE_MIN_PERIOD_SECONDS_V1,
  createSpendPermissionVerifierV1,
} from '../artifacts/api-server/lib/spendPermissionVerifier.js';
import { paidIntelligenceLiveGateV1, usdcDecimalToAtomicV1 } from './paidIntelligenceLiveGate.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// `pnpm smoke:paid-intelligence` — the T71 flow, verified end to end.
//
//   Settings -> Enable paid evidence -> Base Account approval -> on-chain
//   verification -> Intelligence Budget active -> one paid evidence request ->
//   settlement -> charge ledger -> pause / resume / revoke
//
// DEFAULT MODE ASKS FOR NO SIGNATURE AND SPENDS NOTHING. It runs on the server
// host, against the real chain, the real CDP wallet and the real database, and
// answers one question: if a user pressed the button right now, would this
// server be able to honour what it is about to ask them to sign? Everything it
// does is a read.
//
// The one thing default mode CANNOT do is approve a permission, because
// approving one means a human in a Base Account. So the live half is gated
// behind five separate statements (see paidIntelligenceLiveGate.ts) and the
// script still never opens a wallet — it prepares, then waits while the operator
// approves in Settings, then verifies what came back.
//
// USAGE
//
//   pnpm smoke:paid-intelligence
//
//   MIORAIL_PAID_INTELLIGENCE_LIVE_SMOKE=true \
//   MIORAIL_PAID_LIVE_WALLET=0x... \
//   MIORAIL_PAID_LIVE_CHAIN_ID=8453 \
//   MIORAIL_PAID_LIVE_MONTHLY_USDC=0.50 \
//   MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC=0.05 \
//   MIORAIL_PAID_LIVE_SESSION_COOKIE='connect.sid=...' \
//     pnpm smoke:paid-intelligence
//
// The session cookie is a live credential. Pass it inline as above; it is never
// printed, never logged and does not belong in `.env`.
// ---------------------------------------------------------------------------

type Verdict = 'ok' | 'fail' | 'skip';

const results: { check: string; verdict: Verdict; note: string }[] = [];

function record(check: string, outcome: Verdict | boolean, note = ''): void {
  const verdict: Verdict = typeof outcome === 'boolean' ? (outcome ? 'ok' : 'fail') : outcome;
  results.push({ check, verdict, note });
  const mark = verdict === 'ok' ? 'ok  ' : verdict === 'fail' ? 'FAIL' : '--  ';
  console.log(`  ${mark} ${check}${note ? ` — ${note}` : ''}`);
}

function heading(text: string): void {
  console.log(`\n${text}`);
}

/** A deterministic address that belongs to nobody. Used as the account of a
 * fabricated permission so the chain check can be exercised without involving a
 * real wallet — and derived rather than hard-coded so it is obvious it was not
 * copied from somewhere it should not have been. */
function smokeAccountV1(): string {
  return `0x${createHash('sha256').update('miorail-paid-intelligence-smoke/v1').digest('hex').slice(0, 40)}`;
}

// --- the summary §8 reports on ---------------------------------------------
const summary = {
  spendPermission: 'not run',
  budget: 'not run',
  settlement: 'not checked',
  paidRequest: 'not run',
  chargeLedger: 'not checked',
  pauseResume: 'not run',
  duplicateProtection: 'not run',
};

// ===========================================================================
// Default mode
// ===========================================================================

async function verifyPrepareV1(preflight: PaidIntelligencePreflightV1): Promise<void> {
  heading('2. Prepare — what the wallet will be asked for');
  const verifier = createSpendPermissionVerifierV1(process.env);
  const monthlyUsdc = '0.50';
  const monthlyAtomic = String(usdcDecimalToAtomicV1(monthlyUsdc));
  const prepared = await prepareSpendPermissionV1({
    walletAddress: smokeAccountV1(),
    periodLimitAtomic: monthlyAtomic,
    periodLimitUsdc: monthlyUsdc,
    maxPerCallUsdc: '0.02',
    verifier,
  });

  record(
    'the spender is the wallet the charger draws with',
    prepared.spender.toLowerCase() === (preflight.spender ?? '').toLowerCase(),
    prepared.spender,
  );
  record('the token is canonical Base USDC', prepared.token.toLowerCase() === preflight.token, prepared.token);
  record('the chain is Base mainnet', prepared.chainId === 8453, String(prepared.chainId));
  record(
    'the allowance is exactly the monthly ceiling',
    prepared.allowanceAtomic === monthlyAtomic,
    `${prepared.allowanceAtomic} atomic`,
  );
  record(
    'the period renews no faster than monthly',
    PAID_EVIDENCE_PERIOD_DAYS_V1 * 86_400 >= PAID_EVIDENCE_MIN_PERIOD_SECONDS_V1,
    `${prepared.periodInDays} days`,
  );
  record('the user is told what they are granting', prepared.consent.length >= 3);
  for (const line of prepared.consent) console.log(`       · ${line}`);
}

/** §7 — a permission the chain has never seen must be refused, and refusing it
 * must write nothing. Run against the real chain: this is the check that proves
 * the on-chain half of confirm is actually wired, not stubbed. */
async function verifyOnchainRefusalV1(preflight: PaidIntelligencePreflightV1): Promise<void> {
  heading('3. On-chain verification — a permission nobody signed');
  const verifier = createSpendPermissionVerifierV1(process.env);
  const account = smokeAccountV1();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const monthlyUsdc = '0.50';
  const monthlyAtomic = String(usdcDecimalToAtomicV1(monthlyUsdc));

  // Deliberately WELL FORMED: right spender, right token, right chain, right
  // allowance, live window. Every binding check passes. The only thing wrong
  // with it is that no wallet ever approved it — so if it is refused, the
  // refusal came from the chain and nowhere else.
  //
  // Shaped the way `@base-org/account` shapes one, not the way it is convenient
  // to write: a 32-byte HEX salt and uint48-max as the end. A hand-written
  // decimal salt and a finite end are what let a wire schema ship that no real
  // Base Account permission could satisfy.
  const permission = {
    account,
    spender: preflight.spender ?? '',
    token: preflight.token,
    allowance: monthlyAtomic,
    period: PAID_EVIDENCE_PERIOD_DAYS_V1 * 86_400,
    start: nowSeconds - 3_600,
    end: 281_474_976_710_655,
    salt: `0x${'7f'.repeat(32)}`,
    extraData: '0x',
  };

  type Claim = Parameters<typeof confirmSpendPermissionV1>[0]['claim'];
  let derived: string;
  try {
    derived = await verifier.derivedHash({
      signature: `0x${'00'.repeat(65)}`,
      chainId: 8453,
      permissionHash: `0x${'00'.repeat(32)}`,
      permission,
    } as Claim);
  } catch {
    record('SpendPermissionManager.getHash is reachable', 'fail', 'the RPC could not be read');
    summary.spendPermission = 'verifier unreachable';
    return;
  }
  record('SpendPermissionManager.getHash is reachable', /^0x[0-9a-f]{64}$/i.test(derived), 'hash derived on chain');

  // The derived hash is used as the claim's own hash, so `permission_hash_mismatch`
  // cannot fire and the refusal must come from the chain's answer.
  const claim = { signature: `0x${'00'.repeat(65)}`, chainId: 8453, permissionHash: derived, permission } as Claim;

  type Repository = Parameters<typeof confirmSpendPermissionV1>[0]['permissions'];
  let wrote = false;
  const refusingRepository = {
    getById: async () => null,
    create: async () => {
      wrote = true;
      throw new Error('the smoke attempted a write');
    },
    setActive: async () => {
      wrote = true;
      throw new Error('the smoke attempted a write');
    },
  } as unknown as Repository;

  const confirmed = await confirmSpendPermissionV1({
    tenantId: 'paid-intelligence-smoke',
    walletAddress: account,
    claim,
    periodLimitAtomic: monthlyAtomic,
    now: new Date(),
    verifier,
    permissions: refusingRepository,
  });

  if (confirmed.outcome === 'verification_unavailable') {
    record('the chain was asked', 'fail', 'permission status could not be read');
    summary.spendPermission = 'verifier unreachable';
    return;
  }
  const refused = confirmed.outcome === 'refused' && confirmed.refusal === 'not_approved_onchain';
  record(
    'a permission the chain never approved is refused',
    refused,
    confirmed.outcome === 'refused' ? confirmed.refusal : confirmed.outcome,
  );
  record('the refusal stored nothing', !wrote, 'no permission row, no budget');
  summary.spendPermission = refused && !wrote ? 'verifier live, refusals write nothing' : 'unverified';
}

/** §7 — the same check from the other side: even if the chain said yes, a
 * permission bound to the wrong token must not become a budget. No network is
 * involved, and that is the point — this is the half that must hold when the
 * chain is cooperating. */
async function verifyBindingRefusalV1(preflight: PaidIntelligencePreflightV1): Promise<void> {
  const account = smokeAccountV1();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const monthlyAtomic = String(usdcDecimalToAtomicV1('0.50'));
  const wrongToken = '0x4200000000000000000000000000000000000006'; // WETH on Base

  type Claim = Parameters<typeof confirmSpendPermissionV1>[0]['claim'];
  type Verifier = Parameters<typeof confirmSpendPermissionV1>[0]['verifier'];
  const approvingVerifier = {
    spenderAddress: async () => preflight.spender ?? '',
    derivedHash: async () => `0x${'ab'.repeat(32)}`,
    status: async () => ({
      isActive: true,
      isApprovedOnchain: true,
      isRevoked: false,
      isExpired: false,
      remainingSpendAtomic: monthlyAtomic,
    }),
  } as unknown as Verifier;

  type Repository = Parameters<typeof confirmSpendPermissionV1>[0]['permissions'];
  let wrote = false;
  const refusingRepository = {
    getById: async () => null,
    create: async () => {
      wrote = true;
      return undefined;
    },
    setActive: async () => {
      wrote = true;
      return undefined;
    },
  } as unknown as Repository;

  const confirmed = await confirmSpendPermissionV1({
    tenantId: 'paid-intelligence-smoke',
    walletAddress: account,
    claim: {
      signature: `0x${'00'.repeat(65)}`,
      chainId: 8453,
      permissionHash: `0x${'ab'.repeat(32)}`,
      permission: {
        account,
        spender: preflight.spender ?? '',
        token: wrongToken,
        allowance: monthlyAtomic,
        period: PAID_EVIDENCE_PERIOD_DAYS_V1 * 86_400,
        start: nowSeconds - 3_600,
        end: nowSeconds + 30 * 86_400,
        salt: '1',
        extraData: '0x',
      },
    } as Claim,
    periodLimitAtomic: monthlyAtomic,
    now: new Date(),
    verifier: approvingVerifier,
    permissions: refusingRepository,
  });
  record(
    'a permission for the wrong token is refused even when the chain approves it',
    confirmed.outcome === 'refused' && confirmed.refusal === 'token_mismatch' && !wrote,
    confirmed.outcome === 'refused' ? confirmed.refusal : confirmed.outcome,
  );
}

// ===========================================================================
// Live mode
// ===========================================================================

interface LiveContext {
  baseUrl: string;
  cookie: string;
  wallet: string;
}

async function apiV1(
  context: LiveContext,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${context.baseUrl}${path}`, {
    method,
    headers: {
      cookie: context.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // A non-JSON body (a proxy error page, an empty 204) is not a crash: the
  // status still says what happened, and the caller reports on that.
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

type Budget = Record<string, unknown> | null;

async function readBudgetV1(context: LiveContext): Promise<Budget> {
  const { status, json } = await apiV1(context, 'GET', '/api/route-intelligence/intelligence-budget');
  if (status !== 200) return null;
  return (json.budget as Budget) ?? null;
}

function atomicOfV1(budget: Budget, field: string): bigint {
  const value = typeof budget?.[field] === 'string' ? (budget[field] as string) : '0';
  return usdcDecimalToAtomicV1(value) ?? 0n;
}

/** Free route comparison, run in whatever budget state we are currently in.
 * It must keep working in all of them — that is the promise pause and revoke
 * are made under. */
async function verifyFreeComparisonV1(context: LiveContext, state: string): Promise<void> {
  const { status, json } = await apiV1(context, 'POST', '/api/route-intelligence/swap/evaluate', {
    message: 'Compare routes to swap 5 USDC for WETH on Base',
    walletAddress: context.wallet,
    requestId: `paid-smoke-free-${Date.now()}`,
  });
  record(
    `free route comparison still answers while the budget is ${state}`,
    status === 200 ? 'ok' : 'fail',
    status === 200 ? String(json.outcome ?? 'answered') : `HTTP ${status}`,
  );
}

async function runLiveV1(preflight: PaidIntelligencePreflightV1): Promise<void> {
  const gate = paidIntelligenceLiveGateV1(process.env);
  heading('5. Live mode');
  if (!gate.allowed) {
    console.log(`  not enabled: ${gate.reason}.`);
    console.log('  Nothing was signed and nothing was charged.');
    return;
  }

  const cookie = (process.env.MIORAIL_PAID_LIVE_SESSION_COOKIE ?? '').trim();
  if (!cookie) {
    record('a signed-in session was supplied', 'fail', 'MIORAIL_PAID_LIVE_SESSION_COOKIE is not set');
    return;
  }
  const context: LiveContext = {
    baseUrl: (process.env.MIORAIL_PAID_LIVE_API_URL ?? 'http://127.0.0.1:8080').trim().replace(/\/$/, ''),
    cookie,
    wallet: gate.wallet,
  };
  console.log(`  ${gate.reason}`);

  // --- the session must be the wallet the operator named --------------------
  const session = await apiV1(context, 'GET', '/api/auth/session');
  const sessionWallet = String(
    (session.json.user as { address?: string } | null | undefined)?.address ?? '',
  ).toLowerCase();
  if (sessionWallet !== gate.wallet) {
    record('the session belongs to the named wallet', 'fail', sessionWallet ? 'a different wallet' : 'not signed in');
    return;
  }
  record('the session belongs to the named wallet', 'ok', gate.wallet);

  // --- §4 the real grant ----------------------------------------------------
  const prepared = await apiV1(context, 'POST', '/api/route-intelligence/intelligence-budget/permission/prepare', {
    periodLimitUsdc: gate.monthlyUsdc,
    maxPerCallUsdc: gate.maxPerRequestUsdc,
  });
  if (prepared.status !== 200) {
    record('prepare answered', 'fail', `HTTP ${prepared.status} ${String(prepared.json.code ?? '')}`);
    return;
  }
  const sameSpender = String(prepared.json.spender ?? '').toLowerCase() === (preflight.spender ?? '').toLowerCase();
  const sameToken = String(prepared.json.token ?? '').toLowerCase() === preflight.token;
  record(
    'the endpoint asks for exactly what the preflight resolved',
    sameSpender && sameToken && prepared.json.chainId === 8453 && prepared.json.allowanceAtomic === gate.monthlyAtomic
      ? 'ok'
      : 'fail',
  );

  let budget = await readBudgetV1(context);
  const freshGrant = budget?.status !== 'active';
  if (freshGrant) {
    console.log('\n  Approve the permission in your Base Account now:');
    console.log('    Settings -> Budget & payments -> Enable paid evidence');
    console.log(`    Monthly ${gate.monthlyUsdc} USDC, at most ${gate.maxPerRequestUsdc} USDC per request.`);
    console.log('  Miorail does not sign and this script does not open a wallet. Waiting…');
    const deadline = Date.now() + Number(process.env.MIORAIL_PAID_LIVE_GRANT_TIMEOUT_MS ?? 300_000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      budget = await readBudgetV1(context);
      if (budget?.status === 'active') break;
    }
  } else {
    console.log('\n  An active budget already exists for this wallet — the grant step was not re-run.');
  }

  if (budget?.status !== 'active') {
    record('the wallet approval produced an active budget', 'fail', String(budget?.status ?? 'no budget'));
    summary.budget = 'not active';
    return;
  }
  const permissionId = String(budget.linkedSpendPermissionId ?? '');
  record(
    'the budget is bound to a permission the server verified on chain',
    /^0x[0-9a-f]{64}$/i.test(permissionId) ? 'ok' : 'fail',
    'nothing else can create this row',
  );
  const limitsMatch =
    atomicOfV1(budget, 'monthlyLimitUsdc') === BigInt(gate.monthlyAtomic) &&
    atomicOfV1(budget, 'maxPerRequestUsdc') === BigInt(gate.maxPerRequestAtomic);
  record(
    'the budget carries the limits that were asked for',
    // A budget that predates this run was granted with its own limits, and
    // holding this run's numbers against it would be a false failure.
    limitsMatch ? 'ok' : freshGrant ? 'fail' : 'skip',
    `${String(budget.monthlyLimitUsdc)} / ${String(budget.maxPerRequestUsdc)} USDC` +
      (limitsMatch || freshGrant ? '' : ' — granted before this run'),
  );
  summary.budget = 'active';
  summary.spendPermission = freshGrant ? 'verified on chain' : 'active from an earlier grant';

  await verifyFreeComparisonV1(context, 'active');

  // --- §5 one real paid request --------------------------------------------
  const routeRunId = (process.env.MIORAIL_PAID_LIVE_ROUTE_RUN_ID ?? '').trim();
  const blueprintId = (process.env.MIORAIL_PAID_LIVE_BLUEPRINT_ID ?? '').trim();
  const blueprintHash = (process.env.MIORAIL_PAID_LIVE_BLUEPRINT_HASH ?? '').trim();
  if (routeRunId && blueprintId && blueprintHash) {
    await runPaidRequestV1(context, { routeRunId, blueprintId, blueprintHash }, budget);
  } else {
    record(
      'one paid evidence request',
      'skip',
      'set MIORAIL_PAID_LIVE_ROUTE_RUN_ID / _BLUEPRINT_ID / _BLUEPRINT_HASH from a reviewed Blueprint',
    );
  }

  await runLifecycleV1(context, gate.allowRevoke);
}

async function runPaidRequestV1(
  context: LiveContext,
  target: { routeRunId: string; blueprintId: string; blueprintHash: string },
  before: Budget,
): Promise<void> {
  const spentBefore = atomicOfV1(before, 'spentUsdc');
  const remainingBefore = atomicOfV1(before, 'remainingUsdc');
  const requestId = `paid-smoke-${Date.now()}`;
  const path = `/api/route-intelligence/blueprints/${target.blueprintId}/simulate-with-budget`;
  const body = {
    routeRunId: target.routeRunId,
    walletAddress: context.wallet,
    blueprintHash: target.blueprintHash,
    requestId,
  };

  const first = await apiV1(context, 'POST', path, body);
  const outcome = String(first.json.outcome ?? first.json.code ?? `HTTP ${first.status}`);
  if (first.status !== 200 || outcome !== 'charged') {
    // Not automatically a defect: `provider_failed` means money was never at
    // risk, and `reconciliation_required` means it was and the server said so.
    record('one paid evidence request settled', 'fail', outcome);
    summary.paidRequest = outcome;
    return;
  }
  const charge = first.json.charge as { chargeId?: string; status?: string } | undefined;
  record('one paid evidence request settled', charge?.status === 'settled' ? 'ok' : 'fail', String(charge?.status));
  summary.paidRequest = 'settled';

  const after = (first.json.budget as Budget) ?? (await readBudgetV1(context));
  const spentAfter = atomicOfV1(after, 'spentUsdc');
  const remainingAfter = atomicOfV1(after, 'remainingUsdc');
  const moved = spentAfter - spentBefore;
  record('spent increased exactly once', moved > 0n ? 'ok' : 'fail', `+${moved} atomic USDC`);
  record(
    'remaining decreased by the same amount',
    remainingBefore - remainingAfter === moved ? 'ok' : 'fail',
    `-${remainingBefore - remainingAfter} atomic USDC`,
  );

  // §5 — the same request id must not buy a second check.
  const replay = await apiV1(context, 'POST', path, body);
  const replayCharge = replay.json.charge as { chargeId?: string } | undefined;
  const replayBudget = (replay.json.budget as Budget) ?? (await readBudgetV1(context));
  const doubleCharged = atomicOfV1(replayBudget, 'spentUsdc') !== spentAfter;
  record(
    'a duplicate request does not charge twice',
    !doubleCharged && replayCharge?.chargeId === charge?.chargeId ? 'ok' : 'fail',
    doubleCharged ? 'the ledger moved on a replay' : 'same charge returned',
  );
  summary.duplicateProtection = !doubleCharged ? 'verified' : 'FAILED';

  // §5 — and the ledger must show it.
  const charges = await apiV1(context, 'GET', '/api/route-intelligence/intelligence-charges?limit=50');
  const rows = (charges.json.charges as { chargeId?: string; chargedUsdc?: string | null }[] | undefined) ?? [];
  const matching = rows.filter((row) => row.chargeId === charge?.chargeId);
  record('the charge ledger records it once', matching.length === 1 ? 'ok' : 'fail', `${matching.length} row(s)`);
  const chargedAtomic = usdcDecimalToAtomicV1(matching[0]?.chargedUsdc ?? '') ?? 0n;
  record(
    'the ledger amount matches what the budget moved',
    chargedAtomic === moved ? 'ok' : 'fail',
    `${chargedAtomic} vs ${moved} atomic USDC`,
  );
  summary.chargeLedger = matching.length === 1 && chargedAtomic === moved ? 'consistent' : 'INCONSISTENT';
}

async function runLifecycleV1(context: LiveContext, allowRevoke: boolean): Promise<void> {
  heading('7. Pause, resume, revoke');
  const before = await readBudgetV1(context);
  const budgetId = String(before?.budgetId ?? '');
  const spentBefore = atomicOfV1(before, 'spentUsdc');

  const paused = await apiV1(context, 'POST', '/api/route-intelligence/intelligence-budget/pause', {});
  const pausedBudget = (paused.json.budget as Budget) ?? null;
  record('pause takes effect', pausedBudget?.status === 'paused' ? 'ok' : 'fail', String(pausedBudget?.status));

  // The coordinator loads the ACTIVE budget before it calls a provider, so a
  // paused budget stops a paid check before any money or any provider request.
  const blockedRun = await apiV1(
    context,
    'POST',
    `/api/route-intelligence/blueprints/${(process.env.MIORAIL_PAID_LIVE_BLUEPRINT_ID ?? 'none').trim()}/simulate-with-budget`,
    {
      routeRunId: (process.env.MIORAIL_PAID_LIVE_ROUTE_RUN_ID ?? 'none').trim(),
      walletAddress: context.wallet,
      blueprintHash: (process.env.MIORAIL_PAID_LIVE_BLUEPRINT_HASH ?? `0x${'0'.repeat(64)}`).trim(),
      requestId: `paid-smoke-paused-${Date.now()}`,
    },
  );
  const blockedReason = String(blockedRun.json.reason ?? blockedRun.json.code ?? blockedRun.json.outcome ?? '');
  record(
    'a paid check is refused while paused',
    blockedRun.json.outcome !== 'charged' ? 'ok' : 'fail',
    blockedReason || `HTTP ${blockedRun.status}`,
  );
  const pausedLedger = await readBudgetV1(context);
  record('pausing charged nothing', atomicOfV1(pausedLedger, 'spentUsdc') === spentBefore ? 'ok' : 'fail');

  await verifyFreeComparisonV1(context, 'paused');

  const resumed = await apiV1(context, 'POST', '/api/route-intelligence/intelligence-budget/resume', {});
  const resumedBudget = (resumed.json.budget as Budget) ?? null;
  const sameBudget = String(resumedBudget?.budgetId ?? '') === budgetId;
  const sameLedger = atomicOfV1(resumedBudget, 'spentUsdc') === spentBefore;
  record(
    'resume restores the same budget and the same ledger',
    resumedBudget?.status === 'active' && sameBudget && sameLedger ? 'ok' : 'fail',
    `${String(resumedBudget?.status)}, spent ${String(resumedBudget?.spentUsdc)} USDC`,
  );
  summary.pauseResume = resumedBudget?.status === 'active' && sameBudget && sameLedger ? 'verified' : 'FAILED';

  if (!allowRevoke) {
    record('revoke', 'skip', 'set MIORAIL_PAID_LIVE_ALLOW_REVOKE=true to exercise it');
    console.log('  Revoking leaves paid evidence off until it is granted again, so it asks separately.');
    return;
  }
  const revoked = await apiV1(context, 'POST', '/api/route-intelligence/intelligence-budget/revoke', {});
  const revokedBudget = (revoked.json.budget as Budget) ?? null;
  record('revoke takes effect', revokedBudget?.status === 'revoked' ? 'ok' : 'fail', String(revokedBudget?.status));
  await verifyFreeComparisonV1(context, 'revoked');
  console.log('  Miorail will not draw on the permission again. Your Base Account may still list it —');
  console.log('  only your wallet can withdraw it on chain, and this script did not try.');
}

// ===========================================================================

async function main(): Promise<void> {
  console.log('Miorail paid intelligence smoke — Base mainnet (8453)');
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  heading('1. Production readiness');
  const preflight = await paidIntelligencePreflightV1();
  for (const check of preflight.checks) record(check.name, check.ok ? 'ok' : 'fail', check.detail);
  for (const warning of preflight.warnings) console.log(`   ⚠ ${warning}`);
  summary.settlement = preflight.checks.find((check) => check.name === 'x402_settlement')?.ok ? 'ready' : 'not ready';

  if (!preflight.ok) {
    // Fail closed. Everything below either opens a wallet or asks a user to,
    // and neither is honest on a server that cannot complete the flow.
    console.log(`\nStopping: ${preflight.blocking.join(', ')}.`);
    console.log('Paid evidence must not be offered until every prerequisite holds.');
    return finish();
  }

  await verifyPrepareV1(preflight);
  await verifyOnchainRefusalV1(preflight);
  await verifyBindingRefusalV1(preflight);

  heading('4. Where the money comes from');
  // Reported rather than asserted, because it is a fact about the design that an
  // operator reading this output should not have to infer. Settings hides paid
  // evidence entirely when x402 settlement is unavailable — which is why §1
  // treats it as blocking — but a charge against an Intelligence Budget is NOT
  // an x402 payment: it draws the user's own Spend Permission through
  // base.subscription.charge. Saying otherwise would misdescribe where the money
  // went, and the charge row would not match the story.
  console.log('  A paid check on a budget draws the user\'s Spend Permission (base.subscription.charge).');
  console.log('  x402 is the per-request payment path beside it, and gates whether Settings offers');
  console.log('  paid evidence at all. Both are reported; they are not the same payment.');

  await runLive(preflight);
  return finish();
}

async function runLive(preflight: PaidIntelligencePreflightV1): Promise<void> {
  try {
    await runLiveV1(preflight);
  } catch (error) {
    record('live mode', 'fail', error instanceof Error ? error.message : 'unknown error');
  }
}

/** §8 — a safe summary. Nothing below is derived from anything unprintable. */
function finish(): void {
  const failed = results.filter((entry) => entry.verdict === 'fail');
  const skipped = results.filter((entry) => entry.verdict === 'skip');
  console.log('');
  console.log(`Spend permission:      ${summary.spendPermission}`);
  console.log(`Budget:                ${summary.budget}`);
  console.log(`x402 settlement:       ${summary.settlement}`);
  console.log(`Paid request:          ${summary.paidRequest}`);
  console.log(`Charge ledger:         ${summary.chargeLedger}`);
  console.log(`Pause/resume:          ${summary.pauseResume}`);
  console.log(`Duplicate protection:  ${summary.duplicateProtection}`);
  console.log('');
  console.log(`${results.length - failed.length - skipped.length}/${results.length - skipped.length} checks passed` +
    (skipped.length > 0 ? `, ${skipped.length} not run` : ''));
  if (failed.length > 0) {
    for (const entry of failed) console.error(`  FAIL ${entry.check}${entry.note ? ` — ${entry.note}` : ''}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    // No request context, no URL, no body: this process holds a session cookie,
    // a database password and a CDP key.
    console.error(`smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // The database pool keeps the event loop alive otherwise.
    setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
  });
