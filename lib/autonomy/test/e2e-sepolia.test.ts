import test from 'node:test';
import assert from 'node:assert';
import { AutonomyEngine } from '../src/engine.js';

test('T7.7 E2E on Sepolia: autonomous action within session-key limits', async () => {
    const engine = new AutonomyEngine();
    const permId = 'test-perm-1';
    engine.createPermission({
        id: permId,
        userId: 'sepolia-auto-user',
        signerAddress: '0x1',
        limit: 100,
        spent: 0,
        expiresAt: Date.now() + 100000,
        whitelist: ['0x036cbd53842c5426634e7929541ec2318f3dcf7e'],
        isActive: true
    });

    // Test base.subscription.prepareCharge mock
    const { base } = await import('@base-org/account');
    const origPrepareCharge = base.subscription.prepareCharge;
    base.subscription.prepareCharge = async () => ([{
        to: '0xsub',
        data: '0xdata',
        value: 0n // BigInt as expected by the latest version of base-org/account
    }]) as unknown as ReturnType<typeof base.subscription.prepareCharge>;

    try {
        const calls = [{ to: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', data: '0x', value: '0' }];
        const res = await engine.validateAndPrepareExecution(permId, calls, 10);

        assert.strictEqual(res.success, true);
        assert.ok(res.sendCallsRequest);

        const prepared = res.sendCallsRequest as { calls: { to: string }[] };
        assert.strictEqual(prepared.calls.length, 2);
        assert.strictEqual(prepared.calls[0].to, '0xsub');
        assert.strictEqual(prepared.calls[1].to, '0x036cbd53842c5426634e7929541ec2318f3dcf7e');

        const perm = engine.getPermission(permId);
        assert.strictEqual(perm?.spent, 10);

        const res2 = await engine.validateAndPrepareExecution(permId, calls, 100);
        assert.strictEqual(res2.success, false);
        assert.strictEqual(res2.error, 'Spend limit exceeded');

        const res3 = await engine.validateAndPrepareExecution(permId, [{ to: '0xbad' }], 0);
        assert.strictEqual(res3.success, false);
        assert.strictEqual(res3.error, 'Contract 0xbad is not whitelisted');

    } finally {
        base.subscription.prepareCharge = origPrepareCharge;
    }
});
