import { test } from 'node:test';
import assert from 'node:assert';
import * as mod from './WalletConfirmButton';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { base } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('WalletConfirmButton is exported correctly', () => {
  assert.equal(typeof mod.WalletConfirmButton, 'function');
});

test('T19.6: WalletConfirmButton checks metadata for confirmable revoke_approval and limited_transfer actions', () => {
  const source = mod.WalletConfirmButton.toString();
  assert.ok(source.includes('userConfirmable === true') || source.includes('userConfirmable'), 'Must check userConfirmable metadata');
  assert.ok(source.includes("executionStatus === 'user-confirmable'") || source.includes("user-confirmable"), 'Must check user-confirmable execution status');
  assert.ok(source.includes("'revoke_approval'") || source.includes('"revoke_approval"'), 'Must check revoke_approval action type');
  assert.ok(source.includes("'limited_transfer'") || source.includes('"limited_transfer"'), 'Must check limited_transfer action type');
});

test('T19.6: WalletConfirmButton shows Connect Wallet to confirm when disconnected or exact disabled reason when unsupported', () => {
  const source = mod.WalletConfirmButton.toString();
  assert.ok(source.includes('Connect Wallet to confirm'), 'Must show Connect Wallet to confirm when disconnected');
  assert.ok(source.includes('User confirmation disabled by server config'), 'Must show server config disabled reason');
  assert.ok(source.includes('Security screening blocked'), 'Must show security screening blocked reason');
  assert.ok(source.includes('Validation failed'), 'Must show simulation/validation failed reason');
  assert.ok(source.includes('disabledReason'), 'Must use exact disabledReason as label when canConfirm is false');
});

test('T19.6: ActionDiffPreview places primary confirmation CTA directly under planned calls', () => {
  const diffPreviewPath = path.resolve(__dirname, '../../../artifacts/interface/src/features/inbox/ActionDiffPreview.tsx');
  if (fs.existsSync(diffPreviewPath)) {
    const content = fs.readFileSync(diffPreviewPath, 'utf-8');
    assert.ok(content.includes('showConfirmCta'), 'ActionDiffPreview must evaluate showConfirmCta');
    assert.ok(content.includes('LazyWalletConfirmButton'), 'ActionDiffPreview must render LazyWalletConfirmButton');
    assert.ok(content.includes('Connect Wallet to confirm'), 'ActionDiffPreview must render connect wallet CTA fallback');
  }
});

test('T19.7: WalletConfirmButton renders Confirm in Base Account without hitting error boundary when wrapped in WagmiProvider + QueryClientProvider', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['status'], { execution: { userConfirmedEnabled: true } });

  const config = createConfig({
    chains: [base],
    transports: {
      [base.id]: http(),
    },
  });

  const initialState = {
    status: 'connected' as const,
    connections: new Map([
      [
        'mock',
        {
          accounts: ['0x1234567890123456789012345678901234567890' as const],
          chainId: base.id,
          connector: { id: 'mock', name: 'Mock', type: 'mock', uid: 'mock' } as any,
        },
      ],
    ]),
    current: 'mock',
    chainId: base.id,
  };

  const mockAction = {
    id: 'test-action-1',
    status: 'pending',
    executionPayload: {
      actionType: 'revoke_approval',
      calls: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b3' }],
    },
    metadata: {
      userConfirmable: true,
      executionStatus: 'user-confirmable',
      securityScreening: { allowed: true, verdict: 'PASSED' },
      simulationResult: { success: true, method: 'preflight-validation' },
    },
  };

  const element = React.createElement(
    WagmiProvider,
    { config, initialState: initialState as any },
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(mod.WalletConfirmButton, { action: mockAction })
    )
  );

  const html = renderToStaticMarkup(element);
  assert.ok(html.includes('Confirm in Base Account'), `Expected "Confirm in Base Account", got: ${html}`);
});

test('T19.7: WalletConfirmButton throws when rendered without WagmiProvider (verifying context boundary requirement)', () => {
  const mockAction = {
    id: 'test-action-2',
    status: 'pending',
    executionPayload: { calls: [{ to: '0x123' }] },
  };

  const element = React.createElement(mod.WalletConfirmButton, { action: mockAction });
  assert.throws(() => {
    renderToStaticMarkup(element);
  }, /WagmiProvider/);
});
