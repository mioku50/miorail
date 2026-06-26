import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseX402PaymentRequirements } from './index.js';

describe('x402-parser', () => {
  it('parses valid x402 payment requirements object', () => {
    const input = {
      accepts: [
        {
          amount: '1.50',
          payTo: '0x1234567890123456789012345678901234567890',
          asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // USDC on Base Sepolia
          network: '84532',
        }
      ]
    };

    const parsed = parseX402PaymentRequirements(input);
    assert.deepStrictEqual(parsed, input);
  });

  it('parses valid x402 payment requirements string', () => {
    const input = {
      accepts: [
        {
          amount: '5.00',
          payTo: '0x0987654321098765432109876543210987654321',
          asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // USDC on Base Sepolia
          network: '84532',
          version: '1.0',
        }
      ]
    };

    const parsed = parseX402PaymentRequirements(JSON.stringify(input));
    assert.deepStrictEqual(parsed, input);
  });

  it('throws error on invalid object schema', () => {
    const input = {
      accepts: [
        {
          // missing amount, etc
          network: '84532',
        }
      ]
    };

    assert.throws(() => parseX402PaymentRequirements(input), /Failed to parse x402 payment requirements from object:/);
  });

  it('throws error on invalid string json', () => {
    assert.throws(() => parseX402PaymentRequirements('not valid json'), /Failed to parse x402 payment requirements from string:/);
  });
});
