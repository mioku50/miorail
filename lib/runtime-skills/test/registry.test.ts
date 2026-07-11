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
