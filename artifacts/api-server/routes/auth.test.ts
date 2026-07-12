import assert from 'node:assert';
import test, { afterEach, beforeEach } from 'node:test';
import request from 'supertest';
import { app } from '../app';
import { authRouteRuntime, setWalletSignatureVerifierForTests } from './auth';

const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';
const originalNodeEnv = process.env.NODE_ENV;
const originalEnsureUser = authRouteRuntime.ensureUser;

beforeEach(() => {
  // Disable the test-only default tenant for these production-auth regressions.
  process.env.NODE_ENV = 'production';
  authRouteRuntime.ensureUser = async () => undefined;
  setWalletSignatureVerifierForTests(async ({ address }) => address === WALLET_A);
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  authRouteRuntime.ensureUser = originalEnsureUser;
  setWalletSignatureVerifierForTests();
});

async function authenticatedAgent() {
  const agent = request.agent(app);
  const challenge = await agent.post('/api/auth/challenge').send({ address: WALLET_A }).expect(200);
  assert.equal(challenge.body.chainId, 8453);
  assert.match(challenge.body.message, /Chain ID: 8453/);
  assert.match(challenge.body.message, new RegExp(`Nonce: ${challenge.body.nonce}`));
  await agent.post('/api/auth/verify').send({
    message: challenge.body.message,
    signature: '0x1234',
  }).expect(200);
  return agent;
}

test('T43: unauthenticated private API returns 401', async () => {
  const response = await request(app).get('/api/chat/history').expect(401);
  assert.equal(response.body.code, 'authentication_required');
});

test('T43: verified wallet creates the CAIP-10 tenant session', async () => {
  const agent = await authenticatedAgent();
  const response = await agent.get('/api/auth/session').expect(200);
  assert.deepEqual(response.body.user, {
    id: `eip155:8453:${WALLET_A}`,
    address: WALLET_A,
    chainId: 8453,
  });
});

test('T43: altered challenge is rejected and cannot be replayed', async () => {
  const agent = request.agent(app);
  const challenge = await agent.post('/api/auth/challenge').send({ address: WALLET_A }).expect(200);
  await agent.post('/api/auth/verify').send({
    message: `${challenge.body.message} `,
    signature: '0x1234',
  }).expect(401);
  await agent.post('/api/auth/verify').send({
    message: challenge.body.message,
    signature: '0x1234',
  }).expect(401);
});

test('T43: wallet A cannot spoof wallet B or a client userId', async () => {
  const agent = await authenticatedAgent();
  const mismatch = await agent.get(`/api/portfolio?address=${WALLET_B}`).expect(403);
  assert.equal(mismatch.body.code, 'wallet_mismatch');
  const spoof = await agent.get('/api/chat/history?userId=eip155:8453:attacker').expect(403);
  assert.equal(spoof.body.code, 'client_user_id_forbidden');
});

test('T43: execution policy wallet must equal authenticated wallet', async () => {
  const agent = await authenticatedAgent();
  const response = await agent.post('/api/autonomy/config').send({ walletAddress: WALLET_B }).expect(403);
  assert.equal(response.body.code, 'wallet_mismatch');
});
