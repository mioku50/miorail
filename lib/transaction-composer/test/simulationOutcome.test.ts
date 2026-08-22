import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SimulationStateV1 } from '@mioagent/route-domain';
import {
  SIMULATION_OUTCOME_COPY_V1,
  classifySimulationOutcomeV1,
  simulationWasExecutedV1,
} from '../src/simulationOutcome.js';

function stateV1(overrides: Partial<SimulationStateV1>): SimulationStateV1 {
  return {
    status: 'unavailable',
    observedAt: null,
    blockNumber: null,
    requestHash: null,
    responseHash: null,
    errorCode: null,
    ...overrides,
  } as SimulationStateV1;
}

// One simulation, one state. Production put "this swap reverts in simulation"
// and "no simulation provider answered" on the same Review screen, about the
// same swap, because two readers derived the same fact from different inputs.

describe('a simulation is in exactly one state', () => {
  it('a passing simulation is passed', () => {
    assert.equal(classifySimulationOutcomeV1(stateV1({ status: 'passed' })), 'simulation_passed');
  });

  it('a revert is evidence about the route', () => {
    assert.equal(
      classifySimulationOutcomeV1(stateV1({ status: 'failed', errorCode: 'reverted' })),
      'simulation_reverted',
    );
  });

  it('a wallet that cannot pay is not a broken route', () => {
    // The user held 0.000713 ETH and asked to swap 0.001. Calling that
    // "this swap reverts in simulation" blamed the market for the balance.
    assert.equal(
      classifySimulationOutcomeV1(stateV1({ status: 'failed', errorCode: 'insufficient_funds' })),
      'insufficient_funds',
    );
    assert.equal(
      classifySimulationOutcomeV1(stateV1({ status: 'failed', errorCode: 'provider_insufficient_funds' })),
      'insufficient_funds',
    );
  });

  it('a declined call shape is not an absent provider', () => {
    assert.equal(
      classifySimulationOutcomeV1(stateV1({ status: 'unavailable', errorCode: 'provider_method_unsupported' })),
      'simulation_method_unsupported',
    );
  });

  it('an unconfigured or silent provider is unavailable', () => {
    assert.equal(
      classifySimulationOutcomeV1(stateV1({ status: 'unavailable', errorCode: 'provider_not_configured' })),
      'simulation_provider_unavailable',
    );
    assert.equal(classifySimulationOutcomeV1(stateV1({ status: 'not_requested' })), 'simulation_provider_unavailable');
  });

  it('only an executed simulation is evidence about the route', () => {
    assert.equal(simulationWasExecutedV1('simulation_reverted'), true);
    assert.equal(simulationWasExecutedV1('insufficient_funds'), true);
    assert.equal(simulationWasExecutedV1('simulation_method_unsupported'), false);
    assert.equal(simulationWasExecutedV1('simulation_provider_unavailable'), false);
  });
});

describe('the five outcomes never share a sentence', () => {
  it('gives each outcome its own headline and detail', () => {
    const headlines = Object.values(SIMULATION_OUTCOME_COPY_V1).map((copy) => copy.headline);
    assert.equal(new Set(headlines).size, headlines.length);
    const details = Object.values(SIMULATION_OUTCOME_COPY_V1).map((copy) => copy.detail);
    assert.equal(new Set(details).size, details.length);
  });

  it('never says a provider was silent when one reverted', () => {
    assert.doesNotMatch(SIMULATION_OUTCOME_COPY_V1.simulation_reverted.detail, /no simulation provider/i);
    assert.doesNotMatch(SIMULATION_OUTCOME_COPY_V1.insufficient_funds.detail, /no simulation provider/i);
    assert.doesNotMatch(SIMULATION_OUTCOME_COPY_V1.simulation_method_unsupported.detail, /no simulation provider/i);
  });

  it('never blames the route for a wallet that cannot pay', () => {
    assert.match(SIMULATION_OUTCOME_COPY_V1.insufficient_funds.detail, /not about the route/i);
  });
});
