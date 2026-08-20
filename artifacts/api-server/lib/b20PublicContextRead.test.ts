import assert from 'node:assert/strict';
import test from 'node:test';

import { b20PublicContextSearchFromEnv } from './b20PublicContextRead.js';

test('public-context search credentials are scoped to their provider host', () => {
  assert.equal(
    b20PublicContextSearchFromEnv({ LLM_API_KEY: 'tokenforge-key' } as NodeJS.ProcessEnv),
    null,
    'the primary TokenForge key must never be sent to the default Mistral host',
  );

  assert.equal(
    typeof b20PublicContextSearchFromEnv({ MISTRAL_API_KEY: 'mistral-key' } as NodeJS.ProcessEnv),
    'function',
  );

  assert.equal(
    typeof b20PublicContextSearchFromEnv({
      B20_PUBLIC_SEARCH_BASE_URL: 'https://search.example/v1',
      B20_PUBLIC_SEARCH_API_KEY: 'search-key',
    } as NodeJS.ProcessEnv),
    'function',
  );

  assert.equal(
    b20PublicContextSearchFromEnv({
      B20_PUBLIC_SEARCH_BASE_URL: 'not a url',
      B20_PUBLIC_SEARCH_API_KEY: 'search-key',
    } as NodeJS.ProcessEnv),
    null,
  );
});
