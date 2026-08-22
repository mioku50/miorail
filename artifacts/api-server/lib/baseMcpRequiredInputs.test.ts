import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { missingInputsReplyV1, missingProviderInputsV1 } from './baseMcpRequiredInputs.js';

// `requires_input` and `unsupported` were one answer. Brickken's agentRegister
// is fully specified — four required fields in its own plugin spec — and the
// console answered with a paragraph about x402 prepare responses that reads as
// a refusal. A user could not tell what to type next.

describe('a recognised operation asks for the fields it is missing', () => {
  it('names all four agentRegister fields when none are given', () => {
    const result = missingProviderInputsV1('brickken', 'register', 'Register my agent on Base with Brickken');
    assert.ok(result);
    assert.deepEqual(result.missing.map((field) => field.id), ['name', 'description', 'image', 'services']);
    const reply = missingInputsReplyV1(result);
    assert.match(reply, /agentRegister/);
    assert.match(reply, /logo URL/);
    assert.match(reply, /Nothing was sent, prepared or paid/);
  });

  it('stops asking for what the user already supplied', () => {
    const result = missingProviderInputsV1(
      'brickken',
      'register',
      'Register my agent "Mio Researcher" on Brickken, which summarises Base research, logo https://example.com/logo.png, service reports at https://example.com/reports',
    );
    assert.ok(result);
    assert.deepEqual(result.missing.map((field) => field.id), []);
  });

  it('asks for an agent id and a wallet on agentSetWallet', () => {
    const result = missingProviderInputsV1('brickken', 'wallet', 'Set my Base wallet as the Brickken agent wallet');
    assert.ok(result);
    assert.deepEqual(result.missing.map((field) => field.id), ['agent', 'wallet']);
  });

  it('accepts a supplied wallet address', () => {
    const result = missingProviderInputsV1(
      'brickken',
      'wallet',
      'Set agent uuid 7f3a1c22-9d4e-4b11-8a10-5c6d7e8f9012 wallet to 0x1111111111111111111111111111111111111111 on Brickken',
    );
    assert.ok(result);
    assert.deepEqual(result.missing.map((field) => field.id), []);
  });

  it('returns null for an operation with no declared required fields', () => {
    assert.equal(missingProviderInputsV1('bankr', 'latest', 'Show the latest Bankr launches'), null);
  });

  it('leads with the fields, not with the payment architecture', () => {
    // The old reply opened on x402 prepare responses and generic URLs, and a
    // reader could not tell it was a request for four values. The constraint
    // on the logo field ("Miorail will not substitute one") is fine — it is
    // about that field. What must not appear is the architecture as the ANSWER.
    const result = missingProviderInputsV1('brickken', 'register', 'Register my agent on Base with Brickken');
    assert.ok(result);
    const reply = missingInputsReplyV1(result);
    assert.match(reply.split('.')[0], /it still needs/);
    assert.doesNotMatch(reply, /provider-specific prepare response/i);
    assert.doesNotMatch(reply, /quoted payment requirements/i);
  });
});
