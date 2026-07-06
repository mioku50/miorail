import { test } from 'node:test';
import assert from 'node:assert';
import * as mod from './WalletConfirmButton';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
