import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { TokenSecurityProviderEnvResult } from '@mioagent/data-providers';
import { executionSecurityRuntime, loadExecutionSecurityContext } from './executionSecurity.js';

const originalGetProvider = executionSecurityRuntime.getProvider;
const originalSetHealth = executionSecurityRuntime.setHealth;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

afterEach(() => {
  executionSecurityRuntime.getProvider = originalGetProvider;
  executionSecurityRuntime.setHealth = originalSetHealth;
});

function provider(resultStatus: 'ok' | 'failed' | 'high-risk'): TokenSecurityProviderEnvResult {
  return {
    providerName: 'goplus',
    status: 'configured',
    statusCode: 'missing',
    provider: {
      async getTokenSecurity({ tokenAddresses }) {
        return tokenAddresses.map((address) => ({
          address,
          provider: 'goplus' as const,
          status: resultStatus,
          flags: {},
          rawRiskLabels: resultStatus === 'high-risk' ? ['honeypot'] : [],
          summary: resultStatus,
        }));
      },
    },
  };
}

test('execution transfer runs token-level provider and records shared connected health', async () => {
  let health = '';
  const configured = provider('ok');
  let forceFresh: boolean | undefined;
  const getTokenSecurity = configured.provider.getTokenSecurity.bind(configured.provider);
  configured.provider.getTokenSecurity = async (params) => {
    forceFresh = params.forceFresh;
    return getTokenSecurity(params);
  };
  executionSecurityRuntime.getProvider = () => configured;
  executionSecurityRuntime.setHealth = (status) => { health = status; };
  const result = await loadExecutionSecurityContext(8453, 'limited_transfer', [{ to: USDC }]);
  assert.equal(result.required, true);
  assert.equal(result.providerContext.risk, 'connected');
  assert.equal(result.tokenSecurity[0].status, 'ok');
  assert.equal(health, 'connected');
  assert.equal(forceFresh, true);
});

test('execution transfer fails provider health when verdicts are unusable', async () => {
  let health = '';
  executionSecurityRuntime.getProvider = () => provider('failed');
  executionSecurityRuntime.setHealth = (status) => { health = status; };
  const result = await loadExecutionSecurityContext(8453, 'limited_transfer', [{ to: USDC }]);
  assert.equal(result.providerContext.risk, 'failed');
  assert.equal(health, 'failed');
});

test('risk-reducing revoke skips external contract scan', async () => {
  let calls = 0;
  const configured = provider('ok');
  configured.provider.getTokenSecurity = async () => {
    calls += 1;
    return [];
  };
  executionSecurityRuntime.getProvider = () => configured;
  const result = await loadExecutionSecurityContext(8453, 'revoke_approval', [{ to: USDC }]);
  assert.equal(result.required, false);
  assert.equal(calls, 0);
});

test('noncanonical targets are rejected before any external contract scan', async () => {
  let calls = 0;
  const configured = provider('ok');
  configured.provider.getTokenSecurity = async () => {
    calls += 1;
    return [];
  };
  executionSecurityRuntime.getProvider = () => configured;
  const result = await loadExecutionSecurityContext(8453, 'limited_transfer', [
    { to: '0x1111111111111111111111111111111111111111' },
  ]);
  assert.equal(result.required, true);
  assert.equal(result.tokenSecurity.length, 0);
  assert.equal(calls, 0);
});
