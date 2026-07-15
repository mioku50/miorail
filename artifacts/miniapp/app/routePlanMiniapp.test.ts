import assert from 'node:assert/strict';
import test from 'node:test';
import { routePlanMiniappState } from './components/RoutePlanHome.js';

test('miniapp route plan requires the current Base wallet to match the signed session', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  assert.equal(routePlanMiniappState.routeSessionMatches(wallet, wallet, 8453), true);
  assert.equal(routePlanMiniappState.routeSessionMatches(wallet, wallet, 84532), false);
  assert.equal(
    routePlanMiniappState.routeSessionMatches(wallet, '0x2222222222222222222222222222222222222222', 8453),
    false,
  );
});
