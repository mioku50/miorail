import assert from 'node:assert';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { useUiStore } from './state';
import { clearTenantClientState } from './tenantState';

test('T43: wallet switch clears previous tenant query and local UI state', () => {
  const client = new QueryClient();
  client.setQueryData(['chat', 'history'], { messages: [{ content: 'wallet A secret' }] });
  client.setQueryData(['autonomy'], { walletAddress: '0x1111111111111111111111111111111111111111' });
  useUiStore.setState({ inboxFilter: 'pending', focusActionId: 'wallet-a-action', paletteOpen: true });

  clearTenantClientState(client);

  assert.equal(client.getQueryData(['chat', 'history']), undefined);
  assert.equal(client.getQueryData(['autonomy']), undefined);
  assert.equal(useUiStore.getState().inboxFilter, 'all');
  assert.equal(useUiStore.getState().focusActionId, null);
  assert.equal(useUiStore.getState().paletteOpen, false);
});
