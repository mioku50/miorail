import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composerPolicyMessage,
  deriveComposerExecutionMode,
} from '../features/stream/agentComposerState.js';

test('composer capability stays user-confirmed when tenant policy is Off', () => {
  const executionMode = deriveComposerExecutionMode({ mode: 'user-confirmed', userConfirmedEnabled: true });
  assert.equal(executionMode, 'user-confirmed');
  assert.equal(composerPolicyMessage({ executionMode, policyConfigured: false }),
    'User-confirmed available; configure spending limits to prepare transactions.');
});

test('composer is read-only only when status capability is not user-confirmed', () => {
  assert.equal(deriveComposerExecutionMode({ mode: 'read-only', userConfirmedEnabled: false }), 'read-only');
  assert.equal(deriveComposerExecutionMode({ mode: 'user-confirmed', userConfirmedEnabled: false }), 'read-only');
});
