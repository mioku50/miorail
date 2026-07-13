import assert from 'node:assert/strict';
import test from 'node:test';
import { detectRuntimeSkill, getRuntimeSkill, runtimeSkillAvailability } from '../src/index.js';

test('runtime skill registry resolves curated providers without .agents files', () => {
  assert.equal(detectRuntimeSkill('Quote 0.1 USDC to ETH')?.namespace, 'uniswap');
  assert.equal(detectRuntimeSkill('Show Moonwell USDC supply markets')?.namespace, 'moonwell');
  assert.equal(getRuntimeSkill('morpho')?.resultScreener, 'morpho');
});

test('runtime skill availability requires matching provider tools', () => {
  const skill = getRuntimeSkill('moonwell')!;
  assert.equal(runtimeSkillAvailability({ skill, intent: 'read', toolNames: ['morpho_query_markets'] }).available, false);
  assert.equal(runtimeSkillAvailability({ skill, intent: 'read', toolNames: ['moonwell_query_markets'] }).available, true);
});

test('Uniswap quote mapper marks quote-only and never asks for transaction preparation', () => {
  const skill = getRuntimeSkill('uniswap')!;
  assert.deepEqual(skill.argumentMapper('quote', { amountIn: '0.1', tokenIn: 'USDC', tokenOut: 'ETH' }), {
    chain: 'base', amountIn: '0.1', tokenIn: 'USDC', tokenOut: 'ETH', quoteOnly: true,
  });
});

test('Uniswap manifest is the structured, TS source of truth for the plugin_http_request gateway', () => {
  const skill = getRuntimeSkill('uniswap')!;
  assert.deepEqual(skill.manifest, {
    integration: 'http-api',
    chains: [8453],
    allowlist: {
      hosts: ['trade-api.gateway.uniswap.org', 'liquidity.api.uniswap.org'],
      methods: ['GET', 'POST'],
      pathPrefixes: ['/v1/check_approval', '/v1/quote', '/v1/swap', '/lp/'],
    },
    auth: 'api-key',
    risk: ['slippage'],
  });
});

test('Moonwell manifest matches the vendored plugin allowlist and requires no auth', () => {
  const skill = getRuntimeSkill('moonwell')!;
  assert.deepEqual(skill.manifest, {
    integration: 'http-api',
    chains: [8453],
    allowlist: {
      hosts: ['api.moonwell.fi'],
      methods: ['GET', 'POST'],
      pathPrefixes: ['/v1/markets', '/v1/rates', '/v1/positions', '/v1/health', '/v1/rewards', '/v1/token-balance', '/v1/prepare'],
    },
    auth: 'none',
    risk: ['liquidation'],
  });
});

test('MCP-only read skills (e.g. Morpho) carry no HTTP manifest', () => {
  assert.equal(getRuntimeSkill('morpho')!.manifest, undefined);
});
