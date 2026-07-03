import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
import { analyzeApprovalsForRisk, type TokenApproval } from '../lib/portfolioAnalysis.js';

describe('Approvals API & Risk Analysis', () => {
  let oldEnv: string | undefined;

  beforeEach(() => {
    oldEnv = process.env.APPROVAL_PROVIDER;
  });

  afterEach(() => {
    if (oldEnv === undefined) {
      delete process.env.APPROVAL_PROVIDER;
    } else {
      process.env.APPROVAL_PROVIDER = oldEnv;
    }
  });

  test('GET /api/approvals returns 400 when address is missing', async () => {
    const response = await request(app).get('/api/approvals');
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.error, 'Wallet address not configured');
  });

  test('GET /api/approvals returns disabled when APPROVAL_PROVIDER=none', async () => {
    process.env.APPROVAL_PROVIDER = 'none';
    const response = await request(app).get('/api/approvals?address=0x1234567890123456789012345678901234567890');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'disabled');
    assert.strictEqual(response.body.provider, 'none');
    assert.strictEqual(response.body.approvals.length, 0);
  });

  test('analyzeApprovalsForRisk classifies unlimited unverified spender as critical and enforces wording', () => {
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
      }
    ];

    const analysis = analyzeApprovalsForRisk(mockApprovals);
    assert.strictEqual(analysis.unlimitedApprovals, 1);
    assert.strictEqual(analysis.riskySpenderApprovals, 1);
    assert.strictEqual(analysis.findings[0].riskLevel, 'critical');
    assert.strictEqual(analysis.recommendations.length, 1);

    const rec = analysis.recommendations[0];
    assert.strictEqual(rec.riskLevel, 'critical');
    assert.strictEqual(rec.calls.length, 0); // Read-only! Never construct revoke calls automatically.
    assert.ok(rec.description.includes('Consider reviewing this permission in a trusted wallet or revoke interface.'));
    assert.ok(!rec.description.includes('Revoke now'));
    assert.ok(!rec.description.includes('Malicious contract'));
  });
});
