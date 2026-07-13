import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWalletContext } from './walletContext.js';

test('T47 mismatch keeps protocol tools available and selects BaseApp-native execution', () => {
  const result = buildWalletContext({
    tenantWallet: '0x8e525bfce1ef40aa8075ef64e45421b5855c8909',
    environment: 'baseapp',
    baseMcpUsable: true,
    match: {
      checked: true,
      match: false,
      mcpAddresses: ['0x4de27ead5a3c9aeb58c7f812178ddde282670d70'],
    },
  });
  assert.equal(result.protocolToolsStatus, 'available');
  assert.equal(result.walletToolsStatus, 'disabled_wallet_mismatch');
  assert.equal(result.walletContext.walletMatch, false);
  assert.equal(result.walletContext.executionProvider, 'baseapp_native');
});

test('T47 matching normal web retains Base MCP execution lifecycle', () => {
  const wallet = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
  const result = buildWalletContext({
    tenantWallet: wallet,
    environment: 'web',
    baseMcpUsable: true,
    match: { checked: true, match: true, mcpAddresses: [wallet] },
  });
  assert.equal(result.walletToolsStatus, 'available');
  assert.equal(result.walletContext.executionProvider, 'base_mcp');
});
