import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  morphoBorrowArrivalV1,
  morphoBorrowSimulationFromBatchV1,
  type SimulatedBatchV1,
} from '../src/morphoBorrowSimulation.js';

// The two tokens a borrow on the curated NVDAc market actually moves.
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NVDAC = '0x1d02c1a0a5dc2d5e23dcd5bbbed6a9f3e6f5b3e7';

function batch(over: Partial<SimulatedBatchV1> = {}): SimulatedBatchV1 {
  return {
    status: 'success',
    blockNumber: 51_521_606,
    failedCallIndex: null,
    revertReason: null,
    assetChanges: {
      status: 'available',
      unavailableReason: null,
      changes: [{ token: USDC, direction: 'in', amountAtomic: '10000000' }],
    },
    ...over,
  };
}

describe('what reached the wallet, measured', () => {
  test('the loan asset arriving is read in its own atomic units', () => {
    const arrival = morphoBorrowArrivalV1({
      assetChanges: batch().assetChanges,
      loanTokenAddress: USDC,
    });
    assert.deepEqual(arrival, { read: true, assets: 10_000_000n });
  });

  test('a token that is not the loan asset does not count as the loan arriving', () => {
    // A borrow batch moves collateral too. Reading "something arrived" instead
    // of "the loan arrived" would pass a batch that delivered the wrong asset.
    const arrival = morphoBorrowArrivalV1({
      assetChanges: {
        status: 'available',
        unavailableReason: null,
        changes: [{ token: NVDAC, direction: 'in', amountAtomic: '6441519897' }],
      },
      loanTokenAddress: USDC,
    });
    assert.deepEqual(arrival, { read: true, assets: 0n });
  });

  test('a round trip reads as the zero it is, not as the inbound leg', () => {
    const arrival = morphoBorrowArrivalV1({
      assetChanges: {
        status: 'available',
        unavailableReason: null,
        changes: [
          { token: USDC, direction: 'in', amountAtomic: '10000000' },
          { token: USDC, direction: 'out', amountAtomic: '10000000' },
        ],
      },
      loanTokenAddress: USDC,
    });
    assert.deepEqual(arrival, { read: true, assets: 0n });
  });

  test('the address comparison does not depend on how the provider cased it', () => {
    const arrival = morphoBorrowArrivalV1({
      assetChanges: {
        status: 'available',
        unavailableReason: null,
        changes: [{ token: USDC.toUpperCase().replace('0X', '0x'), direction: 'in', amountAtomic: '7' }],
      },
      loanTokenAddress: USDC.toUpperCase().replace('0X', '0x'),
    });
    assert.deepEqual(arrival, { read: true, assets: 7n });
  });
});

describe('what the reading refuses to call a measurement', () => {
  test('a provider that could not prove what moved carries its own reason out', () => {
    const arrival = morphoBorrowArrivalV1({
      assetChanges: { status: 'unavailable', unavailableReason: 'no_logs_emitted', changes: [] },
      loanTokenAddress: USDC,
    });
    assert.equal(arrival.read, false);
    if (arrival.read) return;
    assert.equal(arrival.reason, 'no_logs_emitted');
  });

  test('no asset-change block at all is unread, never empty', () => {
    for (const assetChanges of [null, undefined]) {
      const arrival = morphoBorrowArrivalV1({ assetChanges, loanTokenAddress: USDC });
      assert.equal(arrival.read, false);
      if (arrival.read) return;
      assert.match(arrival.reason, /published no asset changes/);
    }
  });

  test('an amount this build cannot parse makes the whole reading unread', () => {
    // Skipping the entry would understate the arrival, and understating it is
    // the direction that lets a transaction through.
    const arrival = morphoBorrowArrivalV1({
      assetChanges: {
        status: 'available',
        unavailableReason: null,
        changes: [
          { token: USDC, direction: 'in', amountAtomic: '10000000' },
          { token: USDC, direction: 'in', amountAtomic: '0x1e' },
        ],
      },
      loanTokenAddress: USDC,
    });
    assert.equal(arrival.read, false);
  });

  test('a loan asset given as something other than an address is not silently zero', () => {
    const arrival = morphoBorrowArrivalV1({
      assetChanges: batch().assetChanges,
      loanTokenAddress: 'USDC',
    });
    assert.equal(arrival.read, false);
  });
});

describe('a batch becomes the state the verdict reads', () => {
  test('a clean run carries its block and its arrival', () => {
    const simulation = morphoBorrowSimulationFromBatchV1({ batch: batch(), loanTokenAddress: USDC });
    assert.equal(simulation.state, 'executed');
    if (simulation.state !== 'executed') return;
    assert.equal(simulation.blockNumber, 51_521_606);
    assert.deepEqual(simulation.arrival, { read: true, assets: 10_000_000n });
  });

  test('a revert carries no arrival at all, because the EVM discarded its logs', () => {
    const simulation = morphoBorrowSimulationFromBatchV1({
      batch: batch({
        status: 'reverted',
        failedCallIndex: 1,
        revertReason: 'insufficient liquidity',
        assetChanges: {
          status: 'available',
          unavailableReason: null,
          changes: [{ token: USDC, direction: 'in', amountAtomic: '10000000' }],
        },
      }),
      loanTokenAddress: USDC,
    });
    assert.equal(simulation.state, 'reverted');
    if (simulation.state !== 'reverted') return;
    assert.equal(simulation.failedCallIndex, 1);
    assert.equal(simulation.reason, 'insufficient liquidity');
    assert.equal('arrival' in simulation, false);
  });

  test('a run that cannot name its block is not a run a review can cite', () => {
    for (const blockNumber of [0, -1, Number.NaN]) {
      const simulation = morphoBorrowSimulationFromBatchV1({
        batch: batch({ blockNumber }),
        loanTokenAddress: USDC,
      });
      assert.equal(simulation.state, 'not_simulated');
    }
  });
});
