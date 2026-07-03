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
  assert.strictEqual(missingRes.status, 'missing');
  assert.strictEqual(missingRes.provider, 'none');
  assert.strictEqual(missingRes.approvals.length, 0);
  console.log('   ✔ APPROVAL_PROVIDER=none returns missing status with empty approvals');

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

  // 4. Verify UI formatting for approval findings in App.tsx
  console.log('4️⃣ Testing UI formatting and presets in App.tsx...');
  const appPath = path.resolve(__dirname, '../artifacts/interface/src/App.tsx');
  const appContent = fs.readFileSync(appPath, 'utf8');
  assert.ok(appContent.includes('Approval Summary'), 'App.tsx must render Approval Summary badge/header');
  assert.ok(appContent.includes('meta.analysis?.approvalAnalysis'), 'App.tsx must check for approvalAnalysis in metadata');
  assert.ok(appContent.includes('Unlimited: {meta.analysis.approvalAnalysis.unlimitedApprovals}'), 'App.tsx must display unlimited count');
  assert.ok(appContent.includes('Risky: {meta.analysis.approvalAnalysis.riskySpenderApprovals}'), 'App.tsx must display risky spender count');
  assert.ok(appContent.includes('Scan Token Approvals'), 'App.tsx must include Scan Token Approvals preset');
  assert.ok(appContent.includes('Approval Scanner'), 'App.tsx must include Approval Scanner status row in Configure page');
  assert.ok(appContent.includes('approvals connected'), 'App.tsx must include approvals status badge in LeftRail');
  console.log('   ✔ UI formatting for approval findings, LeftRail status badge, Configure table, and presets verified');

  console.log('✅ All T11.5 verification checks passed successfully!');
}

runApprovalsSmokeTest().catch(err => {
  console.error('❌ Smoke test failed:', err);
  process.exit(1);
});
