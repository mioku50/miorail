import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  NOT_VERIFIED_V1,
  verificationHonestyViewV1,
  type VerificationHonestyInputV1,
} from '../src/console/verificationHonesty';

// ---------------------------------------------------------------------------
// The panel exists to say what nobody checked. These mostly assert that it
// cannot stop saying it.
// ---------------------------------------------------------------------------

const USDC = {
  kind: 'erc20' as const,
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  decimals: 6,
};
const MIO = {
  kind: 'erc20' as const,
  address: '0xb200000000000000000000578f3ae29d9e6e0101',
  symbol: 'MIO',
  decimals: 18,
};

function input(overrides: Partial<VerificationHonestyInputV1> = {}): VerificationHonestyInputV1 {
  return {
    inputAsset: USDC,
    outputAsset: MIO,
    contractSecurity: {
      provider: 'goplus',
      required: true,
      status: 'passed',
      verdicts: [
        { address: USDC.address, provider: 'goplus', status: 'ok', summary: 'clean' },
        { address: MIO.address, provider: 'goplus', status: 'ok', summary: null },
      ],
    },
    safetyChecks: [
      {
        id: 'provider_guard_uniswap',
        description: 'Uniswap-specific structural and router-pinning validation',
        status: 'passed',
        detail: null,
      },
      { id: 'linkage_hashes_present', description: 'Hashes are bound', status: 'passed', detail: null },
    ],
    simulation: { state: 'passed' },
    ...overrides,
  };
}

describe('the absence list is not conditional', () => {
  test('every unchecked question is stated even when everything passed', () => {
    const view = verificationHonestyViewV1(input());
    assert.deepEqual(view.notVerified, [...NOT_VERIFIED_V1]);
    assert.ok(view.notVerified.length >= 5);
  });

  test('the same list appears when there is nothing to report at all', () => {
    const view = verificationHonestyViewV1({
      inputAsset: null,
      outputAsset: null,
      contractSecurity: null,
      safetyChecks: [],
      simulation: null,
    });
    assert.deepEqual(view.notVerified, [...NOT_VERIFIED_V1]);
  });

  test('liquidity, locks, holders and price history are each named', () => {
    const text = NOT_VERIFIED_V1.join(' ').toLowerCase();
    for (const topic of ['pool', 'locked', 'holders', 'price history', 'owner']) {
      assert.ok(text.includes(topic), topic);
    }
  });
});

describe('what a token is, is stated as an address', () => {
  test('an unfamiliar token leads with its address and calls its symbol a claim', () => {
    const view = verificationHonestyViewV1(input());
    const receive = view.verified.find((fact) => fact.label === 'You receive');
    assert.ok(receive);
    assert.ok(receive.detail.startsWith(MIO.address), receive.detail);
    assert.match(receive.detail, /the contract answers "MIO"/);
    assert.match(receive.detail, /address is the identity/);
    // Not green: nothing about reading a name makes a token good.
    assert.notEqual(receive.tone, 'good');
  });

  test('a canonical token says it is pinned, which is a different claim', () => {
    const view = verificationHonestyViewV1(input());
    const pay = view.verified.find((fact) => fact.label === 'You pay');
    assert.match(String(pay?.detail), /pinned in this build/);
    assert.equal(pay?.tone, 'good');
  });

  test('native ETH has no contract, and says so rather than showing a blank', () => {
    const view = verificationHonestyViewV1(
      input({ inputAsset: { kind: 'native', address: null, symbol: 'ETH', decimals: 18 } }),
    );
    const pay = view.verified.find((fact) => fact.label === 'You pay');
    assert.match(String(pay?.detail), /no contract to read/);
  });
});

describe('an absent check is never shown as a passing one', () => {
  test('a skipped token-security gate is a warning, not silence', () => {
    const view = verificationHonestyViewV1(
      input({
        contractSecurity: { provider: 'none', required: false, status: 'skipped', verdicts: [] },
      }),
    );
    const security = view.verified.filter((fact) => fact.label === 'Token security');
    assert.equal(security.length, 1);
    assert.equal(security[0].tone, 'warn');
    assert.match(security[0].detail, /no provider was asked/);
  });

  test('a required gate with no verdicts says the provider returned nothing', () => {
    const view = verificationHonestyViewV1(
      input({
        contractSecurity: { provider: 'goplus', required: true, status: 'blocked', verdicts: [] },
      }),
    );
    const security = view.verified.filter((fact) => fact.label === 'Token security');
    assert.equal(security[0].tone, 'warn');
    assert.match(security[0].detail, /returned no verdict/);
  });

  test('an unsimulated batch says what that does NOT prove', () => {
    const view = verificationHonestyViewV1(input({ simulation: { state: 'not_requested' } }));
    const simulation = view.verified.find((fact) => fact.label === 'Simulation');
    assert.equal(simulation?.tone, 'warn');
    assert.match(String(simulation?.detail), /Nothing here proves/);
  });

  test('a failed kernel check carries its own detail rather than a tick', () => {
    const view = verificationHonestyViewV1(
      input({
        safetyChecks: [
          {
            id: 'recipient_is_wallet',
            description: 'Swap call recipient equals the authenticated wallet',
            status: 'failed',
            detail: 'recipient does not equal the wallet',
          },
        ],
      }),
    );
    const calldata = view.verified.find((fact) => fact.label === 'Calldata');
    assert.equal(calldata?.tone, 'warn');
    assert.match(String(calldata?.detail), /recipient does not equal the wallet/);
  });

  test('only the headline kernel checks reach this panel, not the whole list', () => {
    const view = verificationHonestyViewV1(input());
    const calldata = view.verified.filter((fact) => fact.label === 'Calldata');
    assert.equal(calldata.length, 1, 'linkage_hashes_present belongs to the full checks panel');
  });
});
