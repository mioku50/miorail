import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { authRouter, authRouteRuntime, setWalletSignatureVerifierForTests } from './auth.js';
import { STILL_ELIGIBILITY_VERSION_V1 } from '@mioagent/still-engine/eligibility';

const WALLET = `0x${'1'.repeat(40)}`;
const original = { ...authRouteRuntime };

beforeEach(() => {
  authRouteRuntime.challengeLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 20 });
  authRouteRuntime.verifyLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 20 });
  authRouteRuntime.ensureUser = async () => undefined;
  authRouteRuntime.verifyOnchain = async () => false;
  setWalletSignatureVerifierForTests();
});
afterEach(() => {
  Object.assign(authRouteRuntime, original);
  setWalletSignatureVerifierForTests();
});

function fixture(store = new session.MemoryStore()) {
  const app = express();
  app.set('trust proxy', true); // Synthetic documentation-range IPs in these local tests only.
  app.use(express.json());
  app.use(session({ store, secret: 'test-only-session-secret', resave: false, saveUninitialized: false }));
  app.use('/api/auth', authRouter);
  return app;
}

test('challenge has one 20/minute IP budget across case and trailing-slash aliases', async () => {
  const app = fixture();
  for (let i = 0; i < 20; i++) {
    await request(app).post('/api/auth/challenge').set('X-Forwarded-For', '198.51.100.1').send({ address: WALLET }).expect(200);
  }
  const blocked = await request(app).post('/api/auth/CHALLENGE/').set('X-Forwarded-For', '198.51.100.1')
    .send({ address: WALLET }).expect(429);
  assert.equal(blocked.body.error, 'auth_rate_limited');
  assert.equal(blocked.headers['x-ratelimit-limit'], '20');
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  await request(app).post('/api/auth/challenge').set('X-Forwarded-For', '198.51.100.2').send({ address: WALLET }).expect(200);
});

test('invalid requests consume the challenge budget and a refusal saves no session', async (t) => {
  const store = new session.MemoryStore();
  const saved = t.mock.method(store, 'set');
  const app = fixture(store);
  for (let i = 0; i < 20; i++) await request(app).post('/api/auth/challenge').send({}).expect(400);
  await request(app).post('/api/auth/challenge').send({ address: WALLET }).expect(429);
  assert.equal(saved.mock.callCount(), 0);
});

test('verify has its own budget, independent of challenge and of other IPs', async () => {
  const app = fixture();
  for (let i = 0; i < 20; i++) {
    await request(app).post('/api/auth/verify').set('X-Forwarded-For', '198.51.100.1').send({}).expect(401);
  }
  const blocked = await request(app).post('/api/auth/VERIFY/').set('X-Forwarded-For', '198.51.100.1').send({}).expect(429);
  assert.equal(blocked.body.error, 'auth_rate_limited');
  await request(app).post('/api/auth/challenge').set('X-Forwarded-For', '198.51.100.1').send({ address: WALLET }).expect(200);
  await request(app).post('/api/auth/verify').set('X-Forwarded-For', '198.51.100.2').send({}).expect(401);
});

test('a rate-limited challenge cannot overwrite a pending nonce', async () => {
  const app = fixture();
  const agent = request.agent(app);
  const challenge = await agent.post('/api/auth/challenge').send({ address: WALLET }).expect(200);
  for (let i = 0; i < 19; i++) await agent.post('/api/auth/challenge').send({}).expect(400);
  await agent.post('/api/auth/challenge').send({ address: `0x${'2'.repeat(40)}` }).expect(429);
  setWalletSignatureVerifierForTests(async () => true);
  await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature: '0x1234' }).expect(200);
});

test('a rate-limited verify retains the challenge for after the minute ends', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const app = fixture();
  for (let i = 0; i < 20; i++) await request(app).post('/api/auth/verify').send({}).expect(401);
  const agent = request.agent(app);
  const challenge = await agent.post('/api/auth/challenge').send({ address: WALLET }).expect(200);
  await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature: '0x1234' }).expect(429);
  now += 60_000;
  setWalletSignatureVerifierForTests(async () => true);
  await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature: '0x1234' }).expect(200);
});

test('a matching EOA signature is verified locally without any chain request', async () => {
  // This ephemeral test-only account is never funded, exported or used onchain.
  const account = privateKeyToAccount(generatePrivateKey());
  let reads = 0;
  authRouteRuntime.verifyOnchain = async () => { reads++; return false; };
  const agent = request.agent(fixture());
  const challenge = await agent.post('/api/auth/challenge').send({ address: account.address }).expect(200);
  const signature = await account.signMessage({ message: challenge.body.message });
  const response = await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature }).expect(200);
  assert.equal(response.body.user.address, account.address.toLowerCase());
  assert.equal(reads, 0);
  await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature }).expect(401);
  assert.equal(reads, 0, 'replay cannot trigger another verifier');
});

test('a different EOA signer falls back and cannot authenticate a different address', async () => {
  const wrongSigner = privateKeyToAccount(generatePrivateKey());
  let reads = 0;
  authRouteRuntime.verifyOnchain = async () => { reads++; return false; };
  const agent = request.agent(fixture());
  const challenge = await agent.post('/api/auth/challenge').send({ address: WALLET }).expect(200);
  const signature = await wrongSigner.signMessage({ message: challenge.body.message });
  await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature }).expect(401);
  assert.equal(reads, 1);
});

test('contract-style signatures retain the chain verifier and its refusal handling', async () => {
  for (const outcome of ['accept', 'refuse', 'throw'] as const) {
    let reads = 0;
    authRouteRuntime.verifyOnchain = async () => {
      reads++;
      if (outcome === 'throw') throw new Error('chain verification unavailable');
      return outcome === 'accept';
    };
    const agent = request.agent(fixture());
    const challenge = await agent.post('/api/auth/challenge').send({ address: WALLET }).expect(200);
    await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature: '0x1234' })
      .expect(outcome === 'accept' ? 200 : 401);
    assert.equal(reads, 1);
  }
});

test('the existing verifier hook can still refuse a valid EOA signature', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  let reads = 0;
  authRouteRuntime.verifyOnchain = async () => { reads++; return true; };
  setWalletSignatureVerifierForTests(async () => false);
  const agent = request.agent(fixture());
  const challenge = await agent.post('/api/auth/challenge').send({ address: account.address }).expect(200);
  const signature = await account.signMessage({ message: challenge.body.message });
  await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature }).expect(401);
  assert.equal(reads, 0);
});

test('an expired challenge is rejected before any verifier', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let reads = 0;
  authRouteRuntime.verifyOnchain = async () => { reads++; return true; };
  const agent = request.agent(fixture());
  const challenge = await agent.post('/api/auth/challenge').send({ address: WALLET }).expect(200);
  now = Date.parse(challenge.body.expiresAt);
  const refused = await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature: '0x1234' }).expect(401);
  assert.equal(refused.body.error, 'challenge_expired');
  assert.equal(reads, 0);
});

test('a successful new sign-in does not inherit the old session eligibility confirmation', async () => {
  const app = fixture();
  app.post('/fixture/eligibility', (req, res) => {
    req.session.stillEligibility = { version: STILL_ELIGIBILITY_VERSION_V1, wallet: WALLET, confirmedAt: new Date().toISOString() };
    res.sendStatus(200);
  });
  app.get('/fixture/eligibility', (req, res) => res.json({ confirmed: Boolean(req.session.stillEligibility) }));
  const agent = request.agent(app);
  await agent.post('/fixture/eligibility').expect(200);
  const before = await agent.get('/fixture/eligibility').expect(200);
  assert.equal(before.body.confirmed, true);
  setWalletSignatureVerifierForTests(async () => true);
  const challenge = await agent.post('/api/auth/challenge').send({ address: WALLET }).expect(200);
  await agent.post('/api/auth/verify').send({ message: challenge.body.message, signature: '0x1234' }).expect(200);
  const after = await agent.get('/fixture/eligibility').expect(200);
  assert.equal(after.body.confirmed, false);
});
