import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as apiClient from './index.ts';

describe('api-client-react', () => {
  it('should export query and mutation hooks', () => {
    assert.ok(apiClient.useSession, 'useSession should be exported');
    assert.ok(apiClient.useChatHistory, 'useChatHistory should be exported');
    assert.ok(apiClient.useActionsFeed, 'useActionsFeed should be exported');
    assert.ok(apiClient.useSettings, 'useSettings should be exported');
    assert.ok(apiClient.useMemory, 'useMemory should be exported');
    assert.ok(apiClient.useProtocols, 'useProtocols should be exported');
    assert.ok(apiClient.usePortfolio, 'usePortfolio should be exported');

    assert.ok(apiClient.useSendMessage, 'useSendMessage should be exported');
    assert.ok(apiClient.useExecuteAction, 'useExecuteAction should be exported');
    assert.ok(apiClient.useDismissAction, 'useDismissAction should be exported');
    assert.ok(apiClient.useUpdateSettings, 'useUpdateSettings should be exported');
    assert.ok(apiClient.useUpdateMemory, 'useUpdateMemory should be exported');
    assert.ok(apiClient.useToggleProtocol, 'useToggleProtocol should be exported');
    assert.ok(apiClient.useLogin, 'useLogin should be exported');
    assert.ok(apiClient.useLogout, 'useLogout should be exported');
  });
});
