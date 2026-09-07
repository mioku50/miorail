import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_CREATED_SIGNATURE_V1,
  B20_CREATED_TOPIC_V1,
  B20_LAUNCH_DECODER_VERSION_V1,
  B20_LAUNCH_REFUSAL_COPY_V1,
  decodeB20CreatedV1,
  launchIdV1,
  type RawLogV1,
} from '../src/launches.js';
import { B20_FACTORY_V1, keccakWordV1 } from '../src/pinned.js';

// ---------------------------------------------------------------------------
// T69 §1 — the decoder is total, or the feed stops.
//
// The signature this rests on is DERIVED from an observed topic0, not published
// by Base. That makes every test here a test of the same property: when the
// event stops looking like what we recorded, the reader must refuse — never
// produce a token with a guessed field.
//
// The fixture below reproduces a launch actually seen on Base
// (B20 interface research §4.1.1): "o1 mascot" / "DINo1", ASSET,
// 18 decimals, at block 49,401,482.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000d6f666fe8b27595c01';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TX_HASH = `0x${'cd'.repeat(32)}`;

/** The observed ASSET launch, ABI-encoded exactly as the factory emits it. */
const OBSERVED_DATA =
  '0x' +
  '0000000000000000000000000000000000000000000000000000000000000080' +
  '00000000000000000000000000000000000000000000000000000000000000c0' +
  '0000000000000000000000000000000000000000000000000000000000000012' +
  '0000000000000000000000000000000000000000000000000000000000000100' +
  '0000000000000000000000000000000000000000000000000000000000000009' +
  '6f31206d6173636f740000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000005' +
  '44494e6f31000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000';

function log(overrides: Partial<RawLogV1> = {}): RawLogV1 {
  return {
    address: B20_FACTORY_V1,
    topics: [
      B20_CREATED_TOPIC_V1,
      `0x000000000000000000000000${TOKEN.slice(2)}`,
      `0x${'0'.repeat(64)}`,
    ],
    data: OBSERVED_DATA,
    blockNumber: '0x2f1ce8a',
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: '0x3',
    ...overrides,
  };
}

const refuses = (overrides: Partial<RawLogV1>, expected: string): void => {
  const result = decodeB20CreatedV1(log(overrides));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, expected);
};

describe('a known B20Created log decodes to exactly what was observed', () => {
  test('the topic is computed from the signature, not pasted', () => {
    // A pasted hash that drifted from the signature would match nothing, and an
    // empty log stream reads exactly like a quiet week.
    assert.equal(B20_CREATED_TOPIC_V1, keccakWordV1(B20_CREATED_SIGNATURE_V1));
    assert.equal(
      B20_CREATED_TOPIC_V1,
      '0xfd9bf2730513a1709722ff379a0844dfd8f997d600693c2bcc659e188bbdba0d',
      'the observed topic0 on Base',
    );
  });

  test('the observed ASSET launch decodes field for field', () => {
    const result = decodeB20CreatedV1(log());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.launch.tokenAddress, TOKEN);
    assert.equal(result.launch.variant, 'asset');
    assert.equal(result.launch.name, 'o1 mascot');
    assert.equal(result.launch.symbol, 'DINo1');
    assert.equal(result.launch.decimals, 18);
    assert.equal(result.launch.blockNumber, '49401482');
    assert.equal(result.launch.blockHash, BLOCK_HASH);
    assert.equal(result.launch.logIndex, 3);
    assert.equal(result.launch.chainId, 8453);
    assert.equal(result.launch.factoryAddress, B20_FACTORY_V1);
    // Persisted so a future decoder change is visible in the data rather than
    // inferred from a deploy date.
    assert.equal(result.launch.decoderVersion, B20_LAUNCH_DECODER_VERSION_V1);
  });

  test('a STABLECOIN variant decodes as itself', () => {
    const result = decodeB20CreatedV1(
      log({ topics: [B20_CREATED_TOPIC_V1, `0x000000000000000000000000${TOKEN.slice(2)}`, `0x${'0'.repeat(63)}1`] }),
    );
    assert.equal(result.ok && result.launch.variant, 'stablecoin');
  });

  test('one log is one launch, forever', () => {
    assert.equal(launchIdV1({ transactionHash: TX_HASH, logIndex: 3 }), `${TX_HASH}:3`);
    // Case cannot split an identity.
    assert.equal(
      launchIdV1({ transactionHash: TX_HASH.toUpperCase(), logIndex: 3 }),
      launchIdV1({ transactionHash: TX_HASH, logIndex: 3 }),
    );
    assert.notEqual(
      launchIdV1({ transactionHash: TX_HASH, logIndex: 4 }),
      launchIdV1({ transactionHash: TX_HASH, logIndex: 3 }),
    );
  });
});

describe('an event shape that changed stops the reader, and invents nothing', () => {
  test('a log from another contract is refused', () => {
    refuses({ address: '0x1111111111111111111111111111111111111111' }, 'wrong_emitter');
  });

  test('another topic0 is refused', () => {
    refuses({ topics: [keccakWordV1('SomethingElse(address)'), `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`] }, 'wrong_topic');
  });

  test('a different topic count means the event changed, and stops it', () => {
    // The single most important refusal here: a fourth indexed parameter would
    // shift every non-indexed field, and a decoder that ploughed on would
    // record a real token with somebody else's name.
    refuses({ topics: [B20_CREATED_TOPIC_V1, `0x${'0'.repeat(64)}`] }, 'topic_count_mismatch');
    refuses(
      { topics: [B20_CREATED_TOPIC_V1, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`] },
      'topic_count_mismatch',
    );
  });

  test('an unknown variant is refused rather than defaulted to asset', () => {
    refuses(
      { topics: [B20_CREATED_TOPIC_V1, `0x000000000000000000000000${TOKEN.slice(2)}`, `0x${'0'.repeat(62)}09`] },
      'unknown_variant',
    );
  });

  test('a malformed indexed token is refused', () => {
    refuses(
      { topics: [B20_CREATED_TOPIC_V1, `0x${'f'.repeat(64)}`, `0x${'0'.repeat(64)}`] },
      'malformed_indexed_token',
    );
  });

  test('truncated data is refused rather than read past the end', () => {
    refuses({ data: '0x' }, 'malformed_data');
    refuses({ data: `0x${'0'.repeat(64 * 3)}` }, 'malformed_data');
  });

  test('a string offset pointing outside the log is refused', () => {
    // An adversarial or truncated log must not produce a name built from
    // whatever bytes happened to follow.
    const data =
      `0x${'f'.repeat(64)}` +
      '00000000000000000000000000000000000000000000000000000000000000c0' +
      '0000000000000000000000000000000000000000000000000000000000000012' +
      '0000000000000000000000000000000000000000000000000000000000000100';
    refuses({ data }, 'string_out_of_bounds');
  });

  test('a string length running past the data is refused', () => {
    const data =
      '0x0000000000000000000000000000000000000000000000000000000000000080' +
      '00000000000000000000000000000000000000000000000000000000000000c0' +
      '0000000000000000000000000000000000000000000000000000000000000012' +
      '0000000000000000000000000000000000000000000000000000000000000100' +
      // claims a 255-byte name with nothing behind it
      '00000000000000000000000000000000000000000000000000000000000000ff';
    refuses({ data }, 'string_out_of_bounds');
  });

  test('a log with no block identity is refused', () => {
    for (const missing of [
      { blockNumber: null },
      { blockHash: null },
      { transactionHash: null },
      { logIndex: null },
    ]) {
      refuses(missing, 'missing_block_identity');
    }
  });

  test('every refusal is explained for an operator', () => {
    for (const [code, copy] of Object.entries(B20_LAUNCH_REFUSAL_COPY_V1)) {
      assert.ok(copy.length > 20, `${code} needs a real explanation`);
    }
  });

  test('no refusal path ever returns a launch', () => {
    // The property the whole file exists for: there is no branch that fills in
    // a missing field.
    for (const broken of [
      { address: '0x1111111111111111111111111111111111111111' },
      { topics: [B20_CREATED_TOPIC_V1] },
      { data: '0x' },
      { blockHash: null },
    ]) {
      assert.equal(decodeB20CreatedV1(log(broken)).ok, false);
    }
  });
});

describe('the decoder never reaches for a balance provider', () => {
  test('nothing in this module knows about one', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/launches.ts', import.meta.url), 'utf8'),
    );
    // Balance providers do not index B20 precompiles. A launch feed that
    // depended on one would silently return nothing.
    for (const forbidden of ['moralis', 'alchemy', 'covalent', 'zerion', 'portfolio']) {
      assert.ok(!source.toLowerCase().includes(forbidden), `must not use ${forbidden}`);
    }
  });
});
