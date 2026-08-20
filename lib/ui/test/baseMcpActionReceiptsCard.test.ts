import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BaseMcpActionReceiptsCard } from '../src/console/BaseMcpActionReceiptsCard';

test('Activity renders a completed Virtuals action as an Action Receipt, not a Route Proof', () => {
  const html = renderToStaticMarkup(BaseMcpActionReceiptsCard({
    loading: false,
    unavailableReason: null,
    receipts: [{
      id: 'virtuals-1',
      status: 'completed',
      provider: 'base-mcp',
      actionType: 'virtuals',
      operation: 'agent_create',
      agentName: 'Mio Researcher',
      providerObjectId: 'agent-1',
      reconciliationState: 'provider_confirmed',
      transactionHash: null,
      blockNumber: null,
      errorCode: null,
      createdAt: '2026-08-20T20:00:00.000Z',
      routeVerified: false,
    }],
  }));
  assert.match(html, /Virtuals · Mio Researcher/);
  assert.match(html, /agent ID agent-1/);
  assert.match(html, /Action Receipts, not compared routes and not Route Proofs/);
});
