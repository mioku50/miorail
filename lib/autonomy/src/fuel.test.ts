import test, { mock } from 'node:test';
import assert from 'node:assert';
import { base } from '@base-org/account/node';
import { FuelChargeService, clearFuelReservationsForTests, listFuelReservations } from './fuel';
import { InMemorySpendPermissionRepository } from './repository';

const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function repositoryWithPermission(limit = 10) {
  const repository = new InMemorySpendPermissionRepository();
  await repository.create({
    id: 'fuel-permission',
    userId: 'user1',
    chainId: 8453,
    asset: BASE_MAINNET_USDC,
    limit,
    spent: 0,
    whitelist: [BASE_MAINNET_USDC],
    expiresAt: Date.now() + 60_000,
    isActive: true,
  });
  return repository;
}

test('FuelChargeService charges active permission and increments spent only after durable proof', async (t) => {
  clearFuelReservationsForTests();
  const repository = await repositoryWithPermission();
  const service = new FuelChargeService(repository, { walletName: 'miorail-fuel' });

  const getStatus = mock.method(base.subscription, 'getStatus', async () => ({
    isSubscribed: true,
    remainingChargeInPeriod: '10',
  }));
  const charge = mock.method(base.subscription, 'charge', async (opts: { id: string; amount: string; testnet: boolean; walletName?: string }) => ({
    success: true,
    id: `charge-${opts.amount}`,
    transactionHash: '0xabc',
  }));
  t.after(() => {
    getStatus.mock.restore();
    charge.mock.restore();
    clearFuelReservationsForTests();
  });

  const result = await service.charge({
    permissionId: 'fuel-permission',
    amount: 2,
    category: 'inference',
    chainEnv: 'mainnet',
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.proof?.txHash, '0xabc');
  assert.strictEqual(result.chargeId, 'charge-2');
  assert.deepStrictEqual(getStatus.mock.calls[0].arguments, [{ id: 'fuel-permission', testnet: false }]);
  assert.strictEqual((charge.mock.calls[0].arguments[0] as { walletName?: string }).walletName, 'miorail-fuel');
  assert.strictEqual(listFuelReservations('fuel-permission').length, 0);

  const stored = await repository.getById('fuel-permission');
  assert.strictEqual(stored?.spent, 2);
});

test('FuelChargeService does not increment spent when charge proof is missing', async (t) => {
  clearFuelReservationsForTests();
  const repository = await repositoryWithPermission();
  const service = new FuelChargeService(repository);

  const getStatus = mock.method(base.subscription, 'getStatus', async () => ({
    isSubscribed: true,
    remainingChargeInPeriod: '10',
  }));
  const charge = mock.method(base.subscription, 'charge', async () => ({ success: true }));
  t.after(() => {
    getStatus.mock.restore();
    charge.mock.restore();
    clearFuelReservationsForTests();
  });

  const result = await service.charge({
    permissionId: 'fuel-permission',
    amount: 2,
    category: 'premium_data',
    chainEnv: 'mainnet',
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.status, 'missing_charge_proof');
  const stored = await repository.getById('fuel-permission');
  assert.strictEqual(stored?.spent, 0);
});

test('FuelChargeService pending reservations prevent concurrent limit overrun', async () => {
  clearFuelReservationsForTests();
  const repository = await repositoryWithPermission(5);
  const service = new FuelChargeService(repository);

  const reserved = await service.reserve({
    permissionId: 'fuel-permission',
    amount: 4,
    category: 'mcp_tool',
    chainEnv: 'mainnet',
  });
  assert.strictEqual(reserved.success, true);

  const blocked = await service.reserve({
    permissionId: 'fuel-permission',
    amount: 2,
    category: 'mcp_tool',
    chainEnv: 'mainnet',
  });
  assert.strictEqual(blocked.success, false);
  assert.strictEqual(blocked.status, 'limit_exhausted');
  if (reserved.reservation) service.release(reserved.reservation.id);
  clearFuelReservationsForTests();
});

test('FuelChargeService charges an existing reservation without double-counting it as pending', async (t) => {
  clearFuelReservationsForTests();
  const repository = await repositoryWithPermission(2);
  const service = new FuelChargeService(repository);

  const getStatus = mock.method(base.subscription, 'getStatus', async () => ({
    isSubscribed: true,
    remainingChargeInPeriod: '2',
  }));
  const charge = mock.method(base.subscription, 'charge', async () => ({
    success: true,
    id: 'charge-existing-reservation',
    transactionHash: '0xdef',
  }));
  t.after(() => {
    getStatus.mock.restore();
    charge.mock.restore();
    clearFuelReservationsForTests();
  });

  const reserved = await service.reserve({
    permissionId: 'fuel-permission',
    amount: 2,
    category: 'dev_smoke',
    chainEnv: 'mainnet',
  });
  assert.strictEqual(reserved.success, true);
  assert.ok(reserved.reservation);

  const result = await service.chargeReserved({
    permissionId: 'fuel-permission',
    amount: 2,
    category: 'dev_smoke',
    chainEnv: 'mainnet',
  }, reserved.reservation!);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.proof?.txHash, '0xdef');
  assert.strictEqual(listFuelReservations('fuel-permission').length, 0);
  const stored = await repository.getById('fuel-permission');
  assert.strictEqual(stored?.spent, 2);
});
