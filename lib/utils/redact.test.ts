import test from 'node:test';
import assert from 'node:assert/strict';
import { describeErrorV1, errorFactsV1, redactErrorTextV1, redactSecretsV1 } from './redact.js';
import { Logger } from './logger.js';

// Synthetic credentials: shaped like the real ones, belonging to nobody.
const INFURA_KEY = '0123456789abcdef0123456789abcdef';
const ALCHEMY_KEY = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY';
const WALLET = `0x${'1a'.repeat(20)}`;

test('an RPC URL keeps its host and loses its key (audit OPS-2)', () => {
  assert.equal(redactSecretsV1(`URL: https://base-mainnet.infura.io/v3/${INFURA_KEY}`), 'URL: https://base-mainnet.infura.io/v3/…');
  assert.equal(redactSecretsV1(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}.`), 'https://base-mainnet.g.alchemy.com/v2/….');
  assert.equal(redactSecretsV1(`(https://dark-name.base-mainnet.quiknode.pro/${INFURA_KEY}0a1b2c3d/)`), '(https://dark-name.base-mainnet.quiknode.pro/…/)');
  assert.equal(redactSecretsV1(`https://api.example.com/v1/quote?chain=8453&apikey=${INFURA_KEY}&x=1`), 'https://api.example.com/v1/quote?chain=8453&apikey=…&x=1');
  assert.equal(redactSecretsV1('https://api.example.com/q?api_key=short&token=t'), 'https://api.example.com/q?api_key=…&token=…');
  assert.equal(redactSecretsV1('https://user:pass@db.example.com/path'), 'https://db.example.com/path');
  assert.equal(redactSecretsV1('Authorization: Bearer abc.def-ghi_jkl'), 'Authorization: Bearer …');
  assert.equal(redactSecretsV1('https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage'), 'https://api.telegram.org/…/sendMessage');
  assert.doesNotMatch(redactSecretsV1(`a "https://base-mainnet.infura.io/v3/${INFURA_KEY}" b`), new RegExp(INFURA_KEY));
});

test('a URL without a credential is left as it is', () => {
  for (const plain of ['https://api.coinbase.com/v1/tokenized-stocks?page_size=500', 'https://miorail.xyz/api/public/still/terms',
    'GET /api/route-intelligence/swap/blueprints/abc/submission', 'https://base.org/2026-11-14/notes']) {
    assert.equal(redactSecretsV1(plain), plain);
  }
});

test('an error is told by its name, status and code with a redacted first sentence, never its request body', () => {
  // As viem builds an HttpRequestError: the short message, then the URL and the request body on later lines.
  const error = Object.assign(new Error(['HTTP request failed.', '', 'Status: 429', `URL: https://base-mainnet.infura.io/v3/${INFURA_KEY}`,
    `Request body: {"method":"eth_getTransactionCount","params":["${WALLET}","latest"]}`].join('\n')), { name: 'HttpRequestError', status: 429, shortMessage: 'HTTP request failed.' });
  assert.deepEqual(errorFactsV1(error), { errorName: 'HttpRequestError', status: 429, detail: 'HTTP request failed.' });
  assert.equal(describeErrorV1(error), 'HttpRequestError status 429: HTTP request failed.');
  const plain = new Error(`fetch failed for https://base-mainnet.infura.io/v3/${INFURA_KEY} from ${WALLET}`);
  const said = describeErrorV1(plain);
  assert.doesNotMatch(said, new RegExp(`${INFURA_KEY}|${WALLET}`));
  assert.match(said, /^Error: fetch failed for https:\/\/base-mainnet\.infura\.io\/v3\/… from 0x…$/);
  assert.deepEqual(errorFactsV1(Object.assign(new Error('x'), { code: 'ECONNRESET' })), { errorName: 'Error', code: 'ECONNRESET', detail: 'x' });
  assert.equal(describeErrorV1('a string'), 'string: a string');
  assert.equal(redactErrorTextV1(`tx 0x${'ab'.repeat(32)} by ${WALLET}`), 'tx 0x… by 0x…');
});

test('every line the logger writes is redacted, in both formats', () => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => { lines.push(line); };
  try {
    for (const format of ['json', 'text'] as const) {
      new Logger({ app: 'test' }, format).warn('Earn contract preflight threw', { detail: `URL: https://base-mainnet.infura.io/v3/${INFURA_KEY}` });
    }
  } finally {
    console.warn = original;
  }
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotMatch(line, new RegExp(INFURA_KEY));
    assert.match(line, /infura\.io\/v3\/…/);
  }
  assert.equal(JSON.parse(lines[0]!).detail, 'URL: https://base-mainnet.infura.io/v3/…');
});
