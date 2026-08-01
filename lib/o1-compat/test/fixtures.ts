import {
  O1TradingOrderRequestV1Schema,
  O1TradingOrderResponseV1Schema,
  O1_SIGNATURE_PLACEHOLDER_V1,
  type O1TradingOrderRequestV1,
  type O1TradingOrderResponseV1,
} from '../src/contracts.js';

// ---------------------------------------------------------------------------
// Fixtures transcribed from the published specification and the official sample
// (docs.o1.exchange/api/trading; CohumanSpace/o1-api @ 09c575be,
// sampleScripts/execute-trade-interactive.js sha256 b67e3be2…).
//
// These are what the provider says it returns. They are NOT a live capture, and
// nothing here should be read as Miorail having executed anything.
// ---------------------------------------------------------------------------

const SIGNER = '0x2Ec6de17c7D14c76485e3bfc4BB5E653b657ADcc';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TOKEN = '0x4200000000000000000000000000000000000006';
const UNIVERSAL_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';

export function baseOrderRequestFixtureV1(
  overrides: Partial<O1TradingOrderRequestV1> = {},
): O1TradingOrderRequestV1 {
  return O1TradingOrderRequestV1Schema.parse({
    schemaVersion: 'o1-trading-order-request/v1',
    networkId: 8453,
    signerAddress: SIGNER,
    tokenAddress: TOKEN,
    quoteTokenAddress: USDC,
    uiAmount: '100',
    direction: 'buy',
    slippageBps: 100,
    mevProtection: true,
    ...overrides,
  });
}

/** A batch shaped the way the documentation describes: an approve leg and a
 * router leg, with the Permit2 typed data and the signature placeholder. */
export function baseOrderResponseFixtureV1(
  overrides: Partial<O1TradingOrderResponseV1> = {},
): O1TradingOrderResponseV1 {
  return O1TradingOrderResponseV1Schema.parse({
    success: true,
    id: 'order-fixture-1',
    transactions: [
      {
        id: 'tx-approve',
        unsigned: {
          to: USDC,
          // approve(spender, 1_000_000) — an exact allowance.
          data: `0x095ea7b3${'0'.repeat(24)}${UNIVERSAL_ROUTER.slice(2)}${BigInt(1_000_000).toString(16).padStart(64, '0')}`,
          value: '0x0',
          gasLimit: '0xea60',
          chainId: 8453,
        },
      },
      {
        id: 'tx-swap',
        unsigned: {
          to: UNIVERSAL_ROUTER,
          data: `0x3593564c${'ab'.repeat(96)}${O1_SIGNATURE_PLACEHOLDER_V1}`,
          value: '0x0',
          gasLimit: '0x493e0',
          chainId: 8453,
        },
        permit2: {
          eip712: {
            domain: { name: 'Permit2', chainId: 8453 },
            types: { PermitSingle: [] },
            values: { spender: UNIVERSAL_ROUTER },
          },
        },
      },
    ],
    ...overrides,
  });
}

/** The documented response example's chain slip: a Base request answered with a
 * mainnet-bound transaction. */
export function chainMismatchResponseFixtureV1(): O1TradingOrderResponseV1 {
  const base = baseOrderResponseFixtureV1();
  return O1TradingOrderResponseV1Schema.parse({
    ...base,
    transactions: [
      { ...base.transactions[0]!, unsigned: { ...base.transactions[0]!.unsigned, chainId: 1 } },
      base.transactions[1]!,
    ],
  });
}

export function unlimitedApprovalResponseFixtureV1(): O1TradingOrderResponseV1 {
  const base = baseOrderResponseFixtureV1();
  return O1TradingOrderResponseV1Schema.parse({
    ...base,
    transactions: [
      {
        ...base.transactions[0]!,
        unsigned: {
          ...base.transactions[0]!.unsigned,
          data: `0x095ea7b3${'0'.repeat(24)}${UNIVERSAL_ROUTER.slice(2)}${'f'.repeat(64)}`,
        },
      },
      base.transactions[1]!,
    ],
  });
}

export function opaqueCalldataResponseFixtureV1(): O1TradingOrderResponseV1 {
  const base = baseOrderResponseFixtureV1();
  return O1TradingOrderResponseV1Schema.parse({
    ...base,
    transactions: [
      {
        ...base.transactions[0]!,
        unsigned: { ...base.transactions[0]!.unsigned, data: `0xdeadbeef${'00'.repeat(32)}` },
      },
      base.transactions[1]!,
    ],
  });
}

export function doublePlaceholderResponseFixtureV1(): O1TradingOrderResponseV1 {
  const base = baseOrderResponseFixtureV1();
  return O1TradingOrderResponseV1Schema.parse({
    ...base,
    transactions: [
      base.transactions[0]!,
      {
        ...base.transactions[1]!,
        unsigned: {
          ...base.transactions[1]!.unsigned,
          data: `0x3593564c${O1_SIGNATURE_PLACEHOLDER_V1}${'ab'.repeat(32)}${O1_SIGNATURE_PLACEHOLDER_V1}`,
        },
      },
    ],
  });
}
