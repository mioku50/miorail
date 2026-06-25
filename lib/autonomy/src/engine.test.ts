import test from 'node:test';
import assert from 'node:assert';
import { AutonomyEngine } from './engine';

test('AutonomyEngine validation', () => {
  const engine = new AutonomyEngine();

  engine.createPermission({
    id: 'perm1',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 10000,
    isActive: true
  });

  const res1 = engine.validateAndSign('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 50);
  assert.strictEqual(res1.success, true);
  assert.ok(res1.mockSignature);

  const res2 = engine.validateAndSign('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 60);
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error, 'Spend limit exceeded');

  engine.killSwitch('perm1');
  const res3 = engine.validateAndSign('perm1', [{ to: '0xallowed', data: '0x', value: '0' }], 10);
  assert.strictEqual(res3.success, false);
  assert.strictEqual(res3.error, 'Permission is inactive (kill-switch engaged)');
});
