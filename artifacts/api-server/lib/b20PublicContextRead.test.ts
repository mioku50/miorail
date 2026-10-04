import assert from 'node:assert/strict';
import test from 'node:test';

import { b20PublicContextSearchFromEnv } from './b20PublicContextRead.js';

test('public-context search credentials are scoped to their provider host', () => {
  assert.equal(
    b20PublicContextSearchFromEnv({ LLM_API_KEY: 'primary-key' } as NodeJS.ProcessEnv),
    null,
    'the primary lane key is never sent to the search host',
  );

  // OpenRouter is the default host, and its own key is the one it gets.
  assert.equal(typeof b20PublicContextSearchFromEnv({ OPENROUTER_KEY: 'or-key' } as NodeJS.ProcessEnv), 'function');
  assert.equal(typeof b20PublicContextSearchFromEnv({ OPENROUTER_API_KEY: 'or-key' } as NodeJS.ProcessEnv), 'function');

  // Mistral is no longer the default: its key alone looks nowhere, and it
  // answers only where an operator names its host.
  assert.equal(b20PublicContextSearchFromEnv({ MISTRAL_API_KEY: 'mistral-key' } as NodeJS.ProcessEnv), null);
  assert.equal(
    typeof b20PublicContextSearchFromEnv({
      B20_PUBLIC_SEARCH_BASE_URL: 'https://api.mistral.ai',
      MISTRAL_API_KEY: 'mistral-key',
    } as NodeJS.ProcessEnv),
    'function',
  );
  assert.equal(
    b20PublicContextSearchFromEnv({
      B20_PUBLIC_SEARCH_BASE_URL: 'https://api.mistral.ai',
      OPENROUTER_KEY: 'or-key',
    } as NodeJS.ProcessEnv),
    null,
    'an OpenRouter key is never sent to Mistral',
  );

  // A host whose search shape this module cannot read is "cannot look".
  assert.equal(
    b20PublicContextSearchFromEnv({
      B20_PUBLIC_SEARCH_BASE_URL: 'https://search.example/v1',
      B20_PUBLIC_SEARCH_API_KEY: 'search-key',
    } as NodeJS.ProcessEnv),
    null,
  );

  assert.equal(
    b20PublicContextSearchFromEnv({
      B20_PUBLIC_SEARCH_BASE_URL: 'not a url',
      B20_PUBLIC_SEARCH_API_KEY: 'search-key',
    } as NodeJS.ProcessEnv),
    null,
  );
});
