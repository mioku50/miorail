import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeApprovalsForRisk, fetchInternalApprovals, type TokenApproval } from '../artifacts/api-server/lib/portfolioAnalysis.js';

async function runApprovalsSmokeTest() {
  console.log('⚡ Starting Smoke Test: T11.5 Read-only Approval / Spend Permission Scanner');

  // 1. Verify approval scanner provider logic & fallback
  console.log('1️⃣ Testing provider logic when APPROVAL_PROVIDER=none...');
  process.env.APPROVAL_PROVIDER = 'none';
  const missingRes = await fetchInternalApprovals('0x0000000000000000000000000000000000000000');
  assert.ok(missingRes.status === 'missing' || missingRes.status === 'disabled');
  assert.strictEqual(missingRes.provider, 'none');
  assert.strictEqual(missingRes.approvals.length, 0);
  console.log('   ✔ APPROVAL_PROVIDER=none returns disabled/missing status with empty approvals');

  // 2. Verify risk scoring for unlimited/risky spenders
  console.log('2️⃣ Testing risk scoring for unlimited and risky spenders...');
  const mockApprovals: TokenApproval[] = [
    {
      tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      spenderAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      allowanceRaw: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      allowanceFormatted: 'unlimited',
      isUnlimited: true,
      source: 'moralis'
    },
    {
      tokenAddress: '0x4200000000000000000000000000000000000006',
      tokenSymbol: 'WETH',
      tokenName: 'Wrapped Ether',
      spenderAddress: '0x1111111111111111111111111111111111111111',
      spenderLabel: 'Uniswap V3 Router',
      allowanceRaw: '1000000000000000000',
      allowanceFormatted: '1.0',
      isUnlimited: false,
      source: 'moralis',
      lastUpdatedAt: new Date().toISOString()
    }
  ];

  const analysis = analyzeApprovalsForRisk(mockApprovals);
  assert.strictEqual(analysis.totalApprovals, 2);
  assert.strictEqual(analysis.unlimitedApprovals, 1);
  assert.strictEqual(analysis.riskySpenderApprovals, 1);
  assert.strictEqual(analysis.findings[0].riskLevel, 'critical');
  assert.strictEqual(analysis.findings[1].riskLevel, 'low');
  console.log('   ✔ Accurately scored critical risk for unlimited unverified spender and low risk for known protocol');

  // 3. Verify wording constraints & no execution calls
  console.log('3️⃣ Testing wording constraints and read-only execution constraints...');
  const rec = analysis.recommendations[0];
  assert.strictEqual(rec.calls.length, 0, 'Must not create revoke transactions or execution calls');
  assert.ok(rec.description.includes('Consider reviewing this permission in a trusted wallet or revoke interface.'), 'Must use required review wording');
  assert.ok(!rec.description.includes('Revoke now'), 'Must NOT say Revoke now');
  assert.ok(!rec.description.includes('Malicious contract'), 'Must NOT claim Malicious contract with certainty');
  assert.ok(!rec.description.includes('We will revoke this for you'), 'Must NOT claim automated revocation');
  console.log('   ✔ Wording constraints and read-only calls:[] verified');

  // 4. Verify UI formatting for approval findings across interface components
  console.log('4️⃣ Testing UI formatting and presets across interface components...');
  const approvalViewContent = fs.readFileSync(path.resolve(__dirname, '../artifacts/interface/src/features/inbox/ApprovalAnalysisView.tsx'), 'utf8');
  const actionsBuilderContent = fs.readFileSync(path.resolve(__dirname, '../artifacts/interface/src/features/inbox/ActionsBuilder.tsx'), 'utf8');
  const chipsContent = fs.readFileSync(path.resolve(__dirname, '../artifacts/interface/src/features/portfolio/PortfolioProviderChips.tsx'), 'utf8');

  assert.ok(approvalViewContent.includes('Approval Summary'), 'ApprovalAnalysisView must render Approval Summary badge/header');
  assert.ok(approvalViewContent.includes('approvalAnalysis.unlimitedApprovals'), 'ApprovalAnalysisView must display unlimited count');
  assert.ok(approvalViewContent.includes('approvalAnalysis.riskySpenderApprovals'), 'ApprovalAnalysisView must display risky spender count');
  assert.ok(actionsBuilderContent.includes('Scan Token Approvals'), 'ActionsBuilder must include Scan Token Approvals preset');
  // The separate Configure page was deleted with the scanner-era cockpit; its
  // approval-status row now lives in the console's left column.
  assert.ok(chipsContent.includes('approvals connected'), 'PortfolioProviderChips must include approvals status badge');
  console.log('   ✔ UI formatting for approval findings, provider chips, and presets verified');

  // 5. Verify T19.4 defensive protection against invalid builder code and robust ActionCard rendering
  console.log('5️⃣ Testing T19.4 defensive builder code attribution and robust ActionCard rendering...');
  const { builderCodeToDataSuffix } = await import('../lib/wallet-actions/src/attribution.js');
  assert.strictEqual(builderCodeToDataSuffix('placeholder'), undefined, 'placeholder builder code must be ignored');
  assert.strictEqual(builderCodeToDataSuffix('TODO'), undefined, 'TODO builder code must be ignored');
  assert.strictEqual(builderCodeToDataSuffix('!!!bad_code_that_throws!!!', () => { throw new Error('simulated throw'); }), undefined, 'throwing converter must return undefined');

  const actionCardContent = fs.readFileSync(path.resolve(__dirname, '../artifacts/interface/src/features/inbox/ActionCard.tsx'), 'utf8');
  const lazyButtonContent = fs.readFileSync(path.resolve(__dirname, '../artifacts/interface/src/features/inbox/LazyWalletConfirmButton.tsx'), 'utf8');
  assert.ok(actionCardContent.includes('typeof rawPayload === \'string\'') || actionCardContent.includes('JSON.parse(rawPayload)'), 'ActionCard must safely parse string executionPayload');
  assert.ok(lazyButtonContent.includes('WalletConfirmErrorBoundary') && lazyButtonContent.includes('Wallet confirm unavailable'), 'LazyWalletConfirmButton must contain error boundary against crashes');
  console.log('   ✔ T19.4 defensive builder code handling and ActionCard/LazyWalletConfirmButton robust rendering verified');

  // 6. Verify T19.5 WalletConfirmButton poller refactoring and diagnostics
  console.log('6️⃣ Testing T19.5 WalletConfirmButton poller refactoring and diagnostics...');
  const useWalletConfirmActionContent = fs.readFileSync(path.resolve(__dirname, '../lib/wallet-actions/src/useWalletConfirmAction.ts'), 'utf8');
  assert.ok(!useWalletConfirmActionContent.includes('id: batchId ?? \'\''), 'useWalletConfirmAction must not call useCallsStatus with empty string id');
  assert.ok(useWalletConfirmActionContent.includes('CallsStatusPoller'), 'useWalletConfirmAction must encapsulate polling in CallsStatusPoller');
  assert.ok(lazyButtonContent.includes('actionId={actionId}') && lazyButtonContent.includes('actionType={actionType}'), 'LazyWalletConfirmButton must pass actionId and actionType diagnostics to error boundary');
  console.log('   ✔ T19.5 polling refactoring and error diagnostics verified');

  console.log('✅ All T11.5, T19.4 & T19.5 verification checks passed successfully!');
}

runApprovalsSmokeTest().catch(err => {
  console.error('❌ Smoke test failed:', err);
  process.exit(1);
});
