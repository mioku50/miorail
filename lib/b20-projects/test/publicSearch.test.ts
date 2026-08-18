import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_SEARCH_TERM_LIMIT_V1,
  classifyCandidateV1,
  createMistralPublicSearchV1,
  mistralSearchResultsV1,
  publicSearchQueryV1,
  searchTermV1,
} from '../src/publicSearch.js';
import { candidatesFromSearchV1 } from '../src/publicProbe.js';

// ---------------------------------------------------------------------------
// The shape below is production's, taken from a live Mistral response on
// 2026-08-18. Two things in it matter and both are load-bearing:
//
//   the URLs live in `tool.execution.info.result`, as a JSON STRING;
//   the second result for "Aerodrome Finance" was `aerlifi.net`, a copycat.
//
// The second is why this whole layer says "candidate": a search engine ranks a
// convincing impostor second, and no amount of care in the prompt changes that.
// ---------------------------------------------------------------------------

const LIVE_RESPONSE = {
  object: 'conversation.response',
  outputs: [
    {
      object: 'entry',
      type: 'tool.execution',
      name: 'web_search',
      info: {
        result: JSON.stringify({
          CCt0knQJ: {
            url: 'https://aerodrome.finance/',
            title: 'Aerodrome Finance: The central trading and liquidity marketplace on Base network.',
            rank: 0,
            source: 'brave',
          },
          w7mpwjXH: {
            url: 'https://aerlifi.net/',
            title: 'Aerodrome Finance',
            rank: 1,
            source: 'brave',
          },
          Zk1: { url: 'https://github.com/aerodrome-finance/contracts', title: 'contracts', rank: 2, source: 'brave' },
          Zk2: { url: 'https://x.com/aerodromefi', title: 'Aerodrome', rank: 3, source: 'brave' },
          Zk3: { url: 'https://basescan.org/token/0x9401', title: 'Token', rank: 4, source: 'brave' },
        }),
      },
    },
    {
      object: 'entry',
      type: 'message.output',
      role: 'assistant',
      // The model's prose. Nothing may be taken from here.
      content: 'The official website is aerodrome.finance and the GitHub is github.com/invented/repo',
    },
  ],
};

describe('URLs come from the connector, never from the model', () => {
  test('the structured result is read and the assistant message is not', () => {
    const results = mistralSearchResultsV1(LIVE_RESPONSE);
    const urls = results.map((result) => result.url);
    assert.ok(urls.includes('https://aerodrome.finance/'));
    assert.ok(urls.includes('https://github.com/aerodrome-finance/contracts'));
    // The model invented this one in its prose. It must not appear.
    assert.ok(!urls.some((url) => url.includes('invented')));
  });

  test('rank and source travel with the result, and are never a score', () => {
    const first = mistralSearchResultsV1(LIVE_RESPONSE)[0]!;
    assert.equal(first.rank, 0);
    assert.equal(first.source, 'brave');
  });

  test('a response with no tool execution yields nothing at all', () => {
    // This is the OpenRouter shape: an answer, no search, no citations. It has
    // to read as an absence rather than as an answer.
    const noSearch = {
      outputs: [{ type: 'message.output', role: 'assistant', content: 'aerodrome.finance' }],
    };
    assert.deepEqual(mistralSearchResultsV1(noSearch), []);
    assert.deepEqual(mistralSearchResultsV1({}), []);
    assert.deepEqual(mistralSearchResultsV1(null), []);
    assert.deepEqual(mistralSearchResultsV1('{"outputs":[]}'), []);
  });

  test('a malformed connector payload is dropped, not guessed at', () => {
    const broken = { outputs: [{ type: 'tool.execution', name: 'web_search', info: { result: 'not json' } }] };
    assert.deepEqual(mistralSearchResultsV1(broken), []);
  });

  test('a failed HTTP search is an absence', async () => {
    const search = createMistralPublicSearchV1({
      apiKey: 'test',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    assert.deepEqual(await search('anything'), []);
  });

  test('the request never asks the provider to keep the conversation', async () => {
    let sent: unknown = null;
    const search = createMistralPublicSearchV1({
      apiKey: 'test',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify(LIVE_RESPONSE), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await search('q');
    // The query carries a token address and strings a deployer wrote.
    assert.equal((sent as { store?: unknown }).store, false);
    assert.deepEqual((sent as { tools?: unknown }).tools, [{ type: 'web_search' }]);
  });
});

describe('the query is built from the address, and from sanitised text', () => {
  test('the address leads it', () => {
    const query = publicSearchQueryV1({ tokenAddress: '0xB200000000000000000000578F3AE29D9E6E0101', symbol: 'MIO' });
    assert.ok(query.startsWith('0xb200000000000000000000578f3ae29d9e6e0101'));
    assert.ok(query.includes('MIO'));
  });

  test('a name identical to the symbol is not repeated', () => {
    const query = publicSearchQueryV1({ tokenAddress: `0x${'b'.repeat(40)}`, symbol: 'MIO', name: 'mio' });
    assert.equal(query.match(/mio/gi)?.length, 1);
  });

  test('a deployer cannot write the request Miorail sends', () => {
    // `name` and `symbol` come off the launch event, so they are attacker
    // input on their way to a third party.
    assert.equal(searchTermV1('MIO"\n\rinjected'), 'MIO injected');
    assert.equal(searchTermV1('   '), null);
    assert.equal(searchTermV1('"""'), null);
    assert.equal(searchTermV1(null), null);
    assert.equal(searchTermV1('x'.repeat(200))!.length, B20_SEARCH_TERM_LIMIT_V1);
  });
});

describe('a search result is classified or dropped, never guessed', () => {
  test('the three kinds are recognised', () => {
    assert.equal(classifyCandidateV1('https://orbitlab.xyz/'), 'website');
    assert.equal(classifyCandidateV1('https://github.com/orbitlab/os'), 'repository');
    assert.equal(classifyCandidateV1('https://x.com/orbitlab'), 'social');
    assert.equal(classifyCandidateV1('https://twitter.com/orbitlab'), 'social');
  });

  test('a token aggregator is not a project account', () => {
    // basescan is about this token and is not the project. Offering it as a
    // possible website would be wrong about every launch on the chain.
    for (const url of [
      'https://basescan.org/token/0xb2',
      'https://www.dexscreener.com/base/0xb2',
      'https://coingecko.com/en/coins/x',
      'https://t.me/somegroup',
    ]) {
      assert.equal(classifyCandidateV1(url), null, url);
    }
  });

  test('anything not https is refused', () => {
    assert.equal(classifyCandidateV1('http://orbitlab.xyz/'), null);
    assert.equal(classifyCandidateV1('javascript:alert(1)'), null);
    assert.equal(classifyCandidateV1('not a url'), null);
  });

  test('the live result set becomes four candidates, and the impostor is one of them', () => {
    const candidates = candidatesFromSearchV1(mistralSearchResultsV1(LIVE_RESPONSE));
    assert.deepEqual(
      candidates.map((candidate) => `${candidate.kind}:${candidate.host}`),
      ['website:aerodrome.finance', 'website:aerlifi.net', 'repository:github.com', 'social:x.com'],
    );
    // Every one of them is a candidate and none is fetched yet. The impostor is
    // NOT filtered out — nothing here can tell the two apart, and pretending
    // otherwise is the failure. What separates them is the probe.
    assert.ok(candidates.every((candidate) => candidate.origin === 'search_result' && !candidate.fetched));
  });

  test('one candidate per host, so five pages of one site are not five grounds', () => {
    const candidates = candidatesFromSearchV1([
      { url: 'https://orbitlab.xyz/', title: null, rank: 0, source: 'brave' },
      { url: 'https://orbitlab.xyz/about', title: null, rank: 1, source: 'brave' },
      { url: 'https://www.orbitlab.xyz/docs', title: null, rank: 2, source: 'brave' },
    ]);
    assert.equal(candidates.length, 1);
  });
});
