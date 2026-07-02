import test from 'node:test';
import assert from 'node:assert';
import { detectActionIntent } from './intent.js';

test('detectActionIntent ignores greetings and general help', () => {
  assert.strictEqual(detectActionIntent('hello there').isActionIntent, false);
  assert.strictEqual(detectActionIntent('who are you?').isActionIntent, false);
});

test('detectActionIntent detects portfolio review', () => {
  const result = detectActionIntent('check my token portfolio for risky assets');
  assert.strictEqual(result.isActionIntent, true);
  assert.strictEqual(result.intentType, 'portfolio');
});

test('detectActionIntent detects security monitoring', () => {
  const result = detectActionIntent('check spend permissions and watch for suspicious approvals');
  assert.strictEqual(result.isActionIntent, true);
  assert.strictEqual(result.intentType, 'security');
});

test('detectActionIntent detects rebalance plan', () => {
  const result = detectActionIntent('create a recommendation to rebalance ETH and USDC');
  assert.strictEqual(result.isActionIntent, true);
  assert.strictEqual(result.intentType, 'rebalance');
});

test('detectActionIntent detects token security scan phrases', () => {
  for (const phrase of [
    'Check risky tokens',
    'Check token security',
    'Are any tokens dangerous?',
    'Scan my wallet',
    'Check approvals and token risks'
  ]) {
    const result = detectActionIntent(phrase);
    assert.strictEqual(result.isActionIntent, true, phrase);
  }
});
