import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';
import { BASE_UNISWAP_UNIVERSAL_ROUTER_2 } from '@mioagent/security/uniswapGuard';
import {
  baseAppNativeRuntime,
  runDirectBaseAppNativeSend,
  runDirectBaseAppNativeSwap,
} from './streamBaseAppNativeRouting.js';

const TENANT_WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const MCP_WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const TENANT_ID = `eip155:8453:${TENANT_WALLET}`;
const RECIPIENT = '0x1111111111111111111111111111111111111111';

const original = { ...baseAppNativeRuntime };

afterEach(() => {
  Object.assign(baseAppNativeRuntime, original);
});

async function readyRepository() {
  const repository = new InMemoryAutonomyPolicyRepository();
  await repository.configure({
    userId: TENANT_ID,
    chainId: 8453,
    walletAddress: TENANT_WALLET,
    dailyLimit: 20,
    maxPerAction: 5,
    whitelist: [RECIPIENT],
    scope: 'bounded-approval',
    expiresAt: Date.now() + 60 * 60_000,
    mainnetOptIn: true,
  });
  baseAppNativeRuntime.getRepository = () => repository;
  return repository;
}

function usableSecurity() {
  baseAppNativeRuntime.loadTokenSecurity = async (_chainId, addresses) => ({
    required: true,
    providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
    tokenSecurity: addresses.map((address) => ({
      address,
      provider: 'goplus' as const,
      status: 'ok' as const,
    })),
  });
}

test('T47 native send binds the action and wallet_sendCalls payload to the BaseApp tenant wallet', async () => {
  await readyRepository();
  usableSecurity();
  const inserted: any[] = [];
  baseAppNativeRuntime.insertAction = async (row) => { inserted.push(row); };
  baseAppNativeRuntime.evaluate = (async () => ({ allowed: true, success: true, code: 'allowed' })) as any;

  const result = await runDirectBaseAppNativeSend({
    message: `send 0.25 USDC to ${RECIPIENT}`,
    walletAddress: TENANT_WALLET,
    userConfirmedEnabled: true,
    userId: TENANT_ID,
  });

  assert.equal(result?.kind, 'baseapp_native_send');
  assert.equal(result?.errorCode, undefined);
  assert.ok(result?.actionId);
  assert.equal(result?.preparedPayload?.walletAddress, TENANT_WALLET);
  assert.equal(result?.preparedPayload?.tenantId, TENANT_ID);
  assert.equal('approvalUrl' in (result || {}), false);
  assert.equal(inserted[0].userId, TENANT_ID);
  assert.equal(inserted[0].metadata.walletAddress, TENANT_WALLET);
  assert.equal(JSON.parse(inserted[0].executionPayload).actionType, 'limited_transfer');
});

test('T47 native swap prepares only the tenant wallet and never returns the other MCP approval URL', async () => {
  await readyRepository();
  usableSecurity();
  const inserted: any[] = [];
  baseAppNativeRuntime.insertAction = async (row) => { inserted.push(row); };
  baseAppNativeRuntime.prepareUniswap5792 = async (_intent, walletAddress) => {
    assert.equal(walletAddress, TENANT_WALLET);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    return {
      calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x12345678' }],
      requestId: 'tenant-swap',
      expiresAt,
      context: {
        amountDecimal: '0.5',
        inputToken: 'USDC',
        outputToken: 'ETH',
        swapper: TENANT_WALLET,
        routerVersion: '2.0',
        expiresAt,
      },
    };
  };

  const result = await runDirectBaseAppNativeSwap({
    message: 'swap 0.5 USDC to ETH',
    walletAddress: TENANT_WALLET,
    userConfirmedEnabled: true,
    userId: TENANT_ID,
  });

  assert.equal(result?.kind, 'baseapp_native_swap');
  assert.equal(result?.errorCode, undefined);
  assert.equal(result?.preparedPayload?.walletAddress, TENANT_WALLET);
  assert.equal(JSON.stringify(result).includes(MCP_WALLET), false);
  assert.equal(JSON.stringify(result).includes('approvalUrl'), false);
  assert.equal(inserted[0].metadata.walletAddress, TENANT_WALLET);
  assert.equal(inserted[0].metadata.uniswap.swapper, TENANT_WALLET);
});

test('T47 native policy lookup cannot fall through to the Coinbase OAuth wallet', async () => {
  await readyRepository();
  usableSecurity();
  const result = await runDirectBaseAppNativeSend({
    message: `send 0.25 USDC to ${RECIPIENT}`,
    walletAddress: MCP_WALLET,
    userConfirmedEnabled: true,
    userId: `eip155:8453:${MCP_WALLET}`,
  });
  assert.equal(result?.errorCode, 'mainnet_policy_not_ready');
});
