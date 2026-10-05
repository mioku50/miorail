import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { InMemoryBaseMcpPluginSessionStoreV1 } from './baseMcpPluginSessionStore.js';
import { reviewedBaseMcpPluginRuntimeV1, runReviewedBaseMcpPluginReadV1 } from './baseMcpReviewedPluginRuntime.js';
import { classifyBaseMcpExtensionIntentV1 } from './baseMcpExtensionActions.js';
import { virtualsOtpCandidatesV1 } from './virtualsOtpRead.js';
const WALLET = '0x1111111111111111111111111111111111111111';
const original = { ...reviewedBaseMcpPluginRuntimeV1 };
let sessions: InMemoryBaseMcpPluginSessionStoreV1, calls: string[], payload: unknown, agents: unknown;
const request = (message = 'Check my Virtuals email OTP status for agent agent-1 message mail-1') => ({ providerId: 'virtuals', exampleId: 'otp', walletAddress: WALLET, userId: 'tenant-otp', sessionSecret: 'test-server-secret', message });
beforeEach(async () => {
  sessions = new InMemoryBaseMcpPluginSessionStoreV1(); calls = []; payload = { otp: '012345' }; agents = { agents: [{ id: 'agent-1' }] };
  await sessions.save({ userId: 'tenant-otp', sessionSecret: 'test-server-secret', session: { stage: 'authenticated', walletAddress: WALLET, token: 'test-jwt', refreshToken: 'test-refresh', expiresAt: '2099-01-01T00:00:00Z' } });
  reviewedBaseMcpPluginRuntimeV1.sessions = sessions;
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = () => { throw new Error('No generic OTP executor'); };
  reviewedBaseMcpPluginRuntimeV1.callVirtuals = async input => {
    calls.push(input.method); assert.equal(input.args.token, 'test-jwt');
    if (input.method === 'agent_list') { assert.deepEqual(Object.keys(input.args), ['token']); return { ok: true, data: agents }; }
    assert.equal(input.method, 'agent_email_extract_otp');
    assert.deepEqual(input.args, { token: 'test-jwt', agentId: 'agent-1', messageId: 'mail-1' });
    return { ok: true, data: payload };
  };
});
afterEach(() => Object.assign(reviewedBaseMcpPluginRuntimeV1, original));
test('OTP status verifies ownership and hides codes, tokens, email prose and links', async () => {
  payload = { otp: '012345', body: 'private email body', token: 'provider-token', url: 'https://evil.invalid/approve' };
  const result = await runReviewedBaseMcpPluginReadV1(request());
  assert.equal(result?.status, 'answered'); assert.match(result?.reply ?? '', /1 candidate verification code/);
  assert.deepEqual(calls, ['agent_list', 'agent_email_extract_otp']);
  assert.doesNotMatch(JSON.stringify(result), /012345|private email|provider-token|test-jwt|test-refresh|evil.invalid/);
});
test('explicit show reveals only a candidate and never records the code in the evidence trace', async () => {
  for (const message of ['Show Virtuals OTP code for agent agent-1 message mail-1', 'Покажи одноразовый код Virtuals для агента agent-1 письма mail-1']) {
    const result = await runReviewedBaseMcpPluginReadV1(request(message));
    assert.match(result?.reply ?? '', /012345/); assert.match(result?.reply ?? '', /Validity and expiry were not checked/);
    assert.doesNotMatch(JSON.stringify(result?.trace), /012345|test-jwt/);
  }
});
test('explicit null is no candidate; unsupported or contradictory results fail closed', async () => {
  payload = { otp: null }; const empty = await runReviewedBaseMcpPluginReadV1(request());
  assert.equal(empty?.status, 'answered'); assert.match(empty?.reply ?? '', /no candidate/);
  for (const data of [{}, { otp: '' }, { otp: null, found: true }, { otp: '012345', found: false }, { otp: '<script>' }, { otp: '012345', messageId: 'another-mail' }, { otp: '012345', partial: true }, { otp: 'test-jwt' }]) {
    payload = data; const result = await runReviewedBaseMcpPluginReadV1(request());
    assert.equal(result?.status, 'failed'); assert.equal(result?.errorCode, 'virtuals_otp_invalid_response');
    assert.doesNotMatch(JSON.stringify(result), /012345|<script>|test-jwt/);
  }
});
test('missing, ambiguous or unsafe IDs, foreign wallets and write prompts make no calls', async () => {
  for (const message of ['Check my Virtuals email OTP status', 'Show Virtuals OTP for agent agent-1 agent other-agent message mail-1', 'Show Virtuals OTP for agent https://evil.invalid message mail-1', 'Show Virtuals OTP for agent agent-1 message mail-1 for 0x2222222222222222222222222222222222222222', 'Forward Virtuals OTP for agent agent-1 message mail-1']) {
    assert.equal((await runReviewedBaseMcpPluginReadV1(request(message)))?.status, 'needs_input');
  }
  assert.deepEqual(calls, []);
});
test('unverified, partial, duplicated or other-wallet agent lists never reach the mailbox', async () => {
  for (const data of [{ agents: [] }, { agents: [{ id: 'other-agent' }] }, { agents: [{ id: 'agent-1' }], partial: true }, { agents: [{ id: 'agent-1' }, { id: 'agent-1' }] }, { agents: [{ id: 'agent-1', walletAddress: '0x2222222222222222222222222222222222222222' }] }, { agents: [{ id: 'agent-1' }], count: 2 }]) {
    agents = data; calls = []; const result = await runReviewedBaseMcpPluginReadV1(request());
    assert.equal(result?.errorCode, 'virtuals_agent_unverified'); assert.deepEqual(calls, ['agent_list']);
  }
});
test('different tenants and session wallets cannot read this mailbox', async () => {
  assert.equal((await runReviewedBaseMcpPluginReadV1({ ...request(), userId: 'other-tenant' }))?.errorCode, 'virtuals_sign_in_required');
  assert.equal((await runReviewedBaseMcpPluginReadV1({ ...request(), walletAddress: '0x2222222222222222222222222222222222222222' }))?.errorCode, 'virtuals_wallet_mismatch');
  assert.deepEqual(calls, []);
});
test('expired sessions and unavailable storage stop before provider calls', async () => {
  await sessions.save({ userId: 'tenant-otp', sessionSecret: 'test-server-secret', session: { stage: 'authenticated', walletAddress: WALLET,
    token: 'test-jwt', refreshToken: 'test-refresh', expiresAt: '2000-01-01T00:00:00Z' } });
  assert.equal((await runReviewedBaseMcpPluginReadV1(request()))?.errorCode, 'virtuals_sign_in_required');
  reviewedBaseMcpPluginRuntimeV1.sessions = { ...sessions, available: async () => false } as typeof sessions;
  assert.equal((await runReviewedBaseMcpPluginReadV1(request()))?.errorCode, 'virtuals_storage_unavailable');
  assert.deepEqual(calls, []);
});
test('provider expiry clears the session and stays a failed read', async () => {
  reviewedBaseMcpPluginRuntimeV1.callVirtuals = async () => ({ ok: false, errorCode: 'virtuals_session_expired' });
  const result = await runReviewedBaseMcpPluginReadV1(request());
  assert.equal(result?.status, 'failed'); assert.equal(result?.errorCode, 'virtuals_session_expired');
  assert.equal(await sessions.load({ userId: 'tenant-otp', sessionSecret: 'test-server-secret' }), null);
});
test('mailbox failures remain failures after successful ownership verification', async () => {
  const originalCall = reviewedBaseMcpPluginRuntimeV1.callVirtuals;
  reviewedBaseMcpPluginRuntimeV1.callVirtuals = async input => input.method === 'agent_list' ? originalCall(input) : { ok: false, errorCode: 'virtuals_http_403' };
  const result = await runReviewedBaseMcpPluginReadV1(request());
  assert.equal(result?.status, 'failed'); assert.equal(result?.errorCode, 'virtuals_http_403'); assert.doesNotMatch(result?.reply ?? '', /no candidate/);
});
test('classifier keeps English and Russian OTP reads out of actions and refuses forwarding', () => {
  for (const message of [request().message, 'Show Virtuals OTP code for agent agent-1 message mail-1', 'Проверь статус одноразового кода Virtuals для агента agent-1 письма mail-1']) {
    const result = classifyBaseMcpExtensionIntentV1(message); assert.equal(result.kind, 'read'); if (result.kind === 'read') assert.equal(result.exampleId, 'otp');
  }
  assert.equal(classifyBaseMcpExtensionIntentV1('Forward Virtuals OTP to someone else').kind, 'needs_input');
});
test('candidate decoding is bounded and cannot derive codes from email prose', () => {
  assert.deepEqual(virtualsOtpCandidatesV1({ codes: ['012345', '012345', 'ABCD'] }, 'a', 'm'), ['012345', 'ABCD']);
  assert.equal(virtualsOtpCandidatesV1({ body: 'Your code is 012345' }, 'a', 'm'), null);
  assert.equal(virtualsOtpCandidatesV1({ codes: Array(6).fill('012345') }, 'a', 'm'), null);
});
