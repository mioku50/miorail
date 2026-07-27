import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20ControlCardV1Schema,
  B20ControlSnapshotV1Schema,
  B20_ACTIVATION_REGISTRY_V1,
  B20_ALWAYS_BLOCK_V1,
  B20_ERROR_SELECTORS_V1,
  B20_FACTORY_V1,
  B20_FEATURE_KEYS_V1,
  B20_SELECTORS_V1,
  b20TokenIdentityHashV1,
  buildB20CardV1,
  createB20ReaderV1,
  decodeBoolV1,
  decodeStringV1,
  decodeUint8ArrayV1,
  hashB20CardV1,
  inspectB20TokenV1,
  keccakWordV1,
  policyTypeFromIdV1,
  redactRpcTextV1,
  selectorV1,
  validateB20InspectRequestV1,
  variantFromAddressV1,
  B20RequestError,
  type B20ReaderV1,
  type B20RpcResultV1,
} from '../src/index.js';

// A live B20 Asset observed on Base mainnet during the research gate.
const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301';
const STABLE = '0xb2000000000000000000017bf6d5cbb0e24cb301';
const ERC20 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const;
const NOW = new Date('2026-07-27T12:00:00.000Z');

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}
function boolWord(value: boolean): string {
  return `0x${word(value ? 1n : 0n)}`;
}
function stringWord(text: string): string {
  const bytes = Buffer.from(text, 'utf8').toString('hex');
  return `0x${word(32n)}${word(BigInt(text.length))}${bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')}`;
}
function arrayWord(values: number[]): string {
  return `0x${word(32n)}${word(BigInt(values.length))}${values.map((v) => word(BigInt(v))).join('')}`;
}

interface FakeOptions {
  isB20?: B20RpcResultV1<boolean>;
  initialised?: B20RpcResultV1<boolean>;
  activated?: B20RpcResultV1<boolean>;
  anchorFails?: boolean;
  overrides?: Record<string, B20RpcResultV1<string>>;
}

/** A reader that answers from a table. No socket is opened anywhere in this
 * file — a real call would be a test that passes or fails with the weather. */
function fakeReader(options: FakeOptions = {}): B20ReaderV1 {
  const ok = (value: string): B20RpcResultV1<string> => ({ ok: true, value, raw: value });
  const defaults: Record<string, B20RpcResultV1<string>> = {
    [B20_SELECTORS_V1.name]: ok(stringWord('Brian')),
    [B20_SELECTORS_V1.symbol]: ok(stringWord('BRIAN')),
    [B20_SELECTORS_V1.decimals]: ok(`0x${word(18n)}`),
    [B20_SELECTORS_V1.totalSupply]: ok(`0x${word(10n ** 27n)}`),
    [B20_SELECTORS_V1.supplyCap]: ok(`0x${word(10n ** 27n)}`),
    [B20_SELECTORS_V1.pausedFeatures]: ok(arrayWord([])),
    [B20_SELECTORS_V1.contractURI]: ok(stringWord('ipfs://meta')),
    [B20_SELECTORS_V1.multiplier]: ok(`0x${word(10n ** 18n)}`),
    [B20_SELECTORS_V1.currency]: { ok: false, reason: 'reverted', revertSelector: null },
    [B20_SELECTORS_V1.transferSenderPolicy]: ok(`0x${word(1n)}`),
    [B20_SELECTORS_V1.transferReceiverPolicy]: ok(`0x${word(2n)}`),
    [B20_SELECTORS_V1.transferExecutorPolicy]: ok(`0x${word(3n)}`),
    [B20_SELECTORS_V1.mintReceiverPolicy]: ok(`0x${word(4n)}`),
    [B20_SELECTORS_V1.policyId]: ok(`0x${word(0n)}`),
  };
  const table = { ...defaults, ...options.overrides };
  return {
    async readBlockAnchor() {
      return options.anchorFails
        ? { ok: false, reason: 'rpc_unavailable' }
        : { ok: true, value: { blockNumber: '49059662', blockHash: BLOCK_HASH, blockTag: '0x2ee894e' }, raw: '' };
    },
    async readIsB20() {
      return options.isB20 ?? { ok: true, value: true, raw: boolWord(true) };
    },
    async readIsB20Initialized() {
      return options.initialised ?? { ok: true, value: true, raw: boolWord(true) };
    },
    async readVariantActivated() {
      return options.activated ?? { ok: true, value: true, raw: boolWord(true) };
    },
    async call(input) {
      const selector = input.data.slice(2, 10);
      return table[selector] ?? { ok: false, reason: 'rpc_error', detail: `no stub for ${selector}` };
    },
  };
}

function inspect(address = TOKEN, options: FakeOptions = {}) {
  return inspectB20TokenV1({ reader: fakeReader(options) }, {
    tenantId: 'tenant-1',
    chainId: 8453,
    tokenAddress: address,
    now: NOW,
  });
}

describe('the pinned surface is computed, not copied', () => {
  test('selectors match the canonical keccak of their signatures', () => {
    // Independently known values, so a broken selectorV1 cannot confirm itself.
    assert.equal(selectorV1('transfer(address,uint256)'), 'a9059cbb');
    assert.equal(selectorV1('balanceOf(address)'), '70a08231');
    assert.equal(`0x${B20_SELECTORS_V1.totalSupply}`, '0x18160ddd');
    assert.equal(`0x${B20_SELECTORS_V1.decimals}`, '0x313ce567');
    assert.equal(`0x${B20_SELECTORS_V1.name}`, '0x06fdde03');
    assert.equal(`0x${B20_SELECTORS_V1.symbol}`, '0x95d89b41');
  });

  test('the activation feature keys are the keccak of the documented strings', () => {
    assert.equal(B20_FEATURE_KEYS_V1.asset, keccakWordV1('base.b20_asset'));
    assert.equal(B20_FEATURE_KEYS_V1.stablecoin, keccakWordV1('base.b20_stablecoin'));
    assert.equal(
      B20_FEATURE_KEYS_V1.asset,
      '0xcdcc772fe4cbdb1029f822861176d09e646db96723d4c1e82ddfdeb8163ef54c',
      'observed live on Base mainnet during the research gate',
    );
  });

  test('the precompile addresses are the documented singletons', () => {
    assert.equal(B20_FACTORY_V1, '0xb20f000000000000000000000000000000000000');
    assert.equal(B20_ACTIVATION_REGISTRY_V1, '0x8453000000000000000000000000000000000001');
  });
});

describe('decoding refuses to guess', () => {
  test('empty data is null, never false — a pre-activation read is not a verdict', () => {
    assert.equal(decodeBoolV1('0x'), null);
    assert.equal(decodeBoolV1(''), null);
    assert.equal(decodeBoolV1(boolWord(false)), false);
    assert.equal(decodeBoolV1(boolWord(true)), true);
  });

  test('a bool word that is neither 0 nor 1 is null', () => {
    assert.equal(decodeBoolV1(`0x${word(2n)}`), null);
  });

  test('a string with a wrong offset or a truncated body is null', () => {
    assert.equal(decodeStringV1(stringWord('BRIAN')), 'BRIAN');
    assert.equal(decodeStringV1(`0x${word(64n)}${word(5n)}${'42'.repeat(5).padEnd(64, '0')}`), null);
    assert.equal(decodeStringV1(`0x${word(32n)}${word(99n)}${'42'.padEnd(64, '0')}`), null);
  });

  test('an array whose declared length does not match its body is null', () => {
    assert.deepEqual(decodeUint8ArrayV1(arrayWord([0, 2])), [0, 2]);
    assert.deepEqual(decodeUint8ArrayV1(arrayWord([])), []);
    assert.equal(decodeUint8ArrayV1(`0x${word(32n)}${word(4n)}${word(1n)}`), null);
  });

  test('an undocumented policy type stays unknown rather than being named', () => {
    assert.equal(policyTypeFromIdV1(0n), 'blocklist');
    assert.equal(policyTypeFromIdV1(B20_ALWAYS_BLOCK_V1), 'allowlist');
    // UNION / INTERSECT exist in base-std main but not in the published spec.
    assert.equal(policyTypeFromIdV1(2n << 56n), 'unknown');
    assert.equal(policyTypeFromIdV1(3n << 56n), 'unknown');
  });

  test('the variant byte is read at index 10, and an odd address yields null', () => {
    assert.equal(variantFromAddressV1(TOKEN), 'asset');
    assert.equal(variantFromAddressV1(STABLE), 'stablecoin');
    assert.equal(variantFromAddressV1('0xnope'), null);
    // Byte 10 = 0x99 is not a documented variant.
    assert.equal(variantFromAddressV1('0xb200000000000000000099aabbccddeeff001122'), null);
  });
});

describe('detection', () => {
  test('a confirmed B20 produces a complete-or-partial snapshot bound to one block', async () => {
    const { snapshot, card } = await inspect();
    assert.equal(snapshot.detection.outcome, 'b20');
    assert.equal(snapshot.detection.variant, 'asset');
    assert.equal(snapshot.blockNumber, '49059662');
    assert.equal(snapshot.blockHash, BLOCK_HASH);
    // Every evidence record is pinned to the SAME block. The schema enforces
    // it; this asserts the builder actually satisfies the schema.
    assert.ok(snapshot.evidence.length > 0);
    assert.ok(snapshot.evidence.every((e) => e.blockNumber === '49059662' && e.blockHash === BLOCK_HASH));
    assert.equal(card.detectionOutcome, 'b20');
    assert.equal(card.displaySymbol, 'BRIAN');
  });

  test('an ordinary ERC-20 is not_b20 and carries no control rows', async () => {
    const { snapshot, card } = await inspect(ERC20, { isB20: { ok: true, value: false, raw: boolWord(false) } });
    assert.equal(snapshot.detection.outcome, 'not_b20');
    assert.equal(snapshot.status, 'not_b20');
    assert.equal(snapshot.fields.length, 0);
    assert.equal(card.statements.length, 0, 'an ordinary ERC-20 gets no B20 control claims');
    assert.equal(card.variant, null);
  });

  test('an empty factory answer is unavailable_at_block, NOT not_b20', async () => {
    // The trap from the research gate: `0x` decodes to false, which would tell
    // a user an address is an ordinary ERC-20 on the strength of a read that
    // was taken before B20 existed.
    const { snapshot } = await inspect(TOKEN, { isB20: { ok: false, reason: 'empty_result' } });
    assert.equal(snapshot.detection.outcome, 'unavailable_at_block');
    assert.notEqual(snapshot.detection.outcome, 'not_b20');
    assert.equal(snapshot.status, 'failed');
  });

  test('an RPC failure is rpc_failure, never a statement about the token', async () => {
    const { snapshot } = await inspect(TOKEN, { isB20: { ok: false, reason: 'rpc_timeout' } });
    assert.equal(snapshot.detection.outcome, 'rpc_failure');
    assert.equal(snapshot.status, 'failed');
  });

  test('an unreachable endpoint fails before any token read', async () => {
    const { snapshot } = await inspect(TOKEN, { anchorFails: true });
    assert.equal(snapshot.detection.outcome, 'rpc_failure');
    assert.equal(snapshot.blockNumber, null);
  });

  test('a malformed address and a wrong chain are refused without a socket', async () => {
    // These produce NO snapshot: a snapshot is keyed by chain + address, and
    // neither exists here. They are caller errors, decided before any read.
    assert.equal(validateB20InspectRequestV1(8453, '0x1234'), 'invalid_address');
    assert.equal(validateB20InspectRequestV1(84532, TOKEN), 'unsupported_chain');
    assert.equal(validateB20InspectRequestV1(8453, TOKEN), null);

    const detonator: B20ReaderV1 = {
      readBlockAnchor: () => {
        throw new Error('refused input must never reach the network');
      },
    } as unknown as B20ReaderV1;
    await assert.rejects(
      inspectB20TokenV1({ reader: detonator }, { tenantId: 't', chainId: 8453, tokenAddress: '0x1234', now: NOW }),
      (error: unknown) => error instanceof B20RequestError && error.refusal === 'invalid_address',
    );
    await assert.rejects(
      inspectB20TokenV1({ reader: detonator }, { tenantId: 't', chainId: 84532, tokenAddress: TOKEN, now: NOW }),
      (error: unknown) => error instanceof B20RequestError && error.refusal === 'unsupported_chain',
    );
  });

  test('an EOA answers not_b20 like any other non-B20 address', async () => {
    const { snapshot } = await inspect('0x1111111111111111111111111111111111111111', {
      isB20: { ok: true, value: false, raw: boolWord(false) },
    });
    assert.equal(snapshot.detection.outcome, 'not_b20');
  });

  test('a created-but-uninitialised token is reported as such', async () => {
    const { snapshot } = await inspect(TOKEN, { initialised: { ok: true, value: false, raw: boolWord(false) } });
    assert.equal(snapshot.detection.outcome, 'b20_uninitialised');
  });
});

describe('fields', () => {
  test('a variant-specific method that reverts is unsupported, not unavailable', async () => {
    const { snapshot } = await inspect();
    const currency = snapshot.fields.find((f) => f.key === 'stablecoin_currency');
    assert.equal(currency?.status, 'unsupported_by_variant');
    assert.equal(currency?.value, null);
    assert.match(currency?.reason ?? '', /asset variant/);
  });

  test('an unrecognised policy scope revert is reported as unsupported', async () => {
    const { snapshot } = await inspect(TOKEN, {
      overrides: {
        [B20_SELECTORS_V1.policyId]: {
          ok: false,
          reason: 'reverted',
          revertSelector: B20_ERROR_SELECTORS_V1.unsupportedPolicyType,
        },
      },
    });
    const scope = snapshot.fields.find((f) => f.key === 'transfer_sender_policy');
    assert.equal(scope?.status, 'unsupported_by_variant');
    assert.match(scope?.reason ?? '', /does not define that policy scope/);
  });

  test('a missing field is unavailable with a stated reason and no value', async () => {
    const { snapshot } = await inspect(TOKEN, {
      overrides: { [B20_SELECTORS_V1.supplyCap]: { ok: false, reason: 'rate_limited' } },
    });
    const cap = snapshot.fields.find((f) => f.key === 'supply_cap');
    assert.equal(cap?.status, 'unavailable');
    assert.equal(cap?.value, null);
    assert.match(cap?.reason ?? '', /rate_limited/);
    assert.equal(snapshot.status, 'partial', 'a snapshot with a hole is partial, never complete');
  });

  test('an undecodable response does not become a zero', async () => {
    const { snapshot } = await inspect(TOKEN, {
      overrides: { [B20_SELECTORS_V1.totalSupply]: { ok: true, value: '0xdeadbeef', raw: '0xdeadbeef' } },
    });
    const supply = snapshot.fields.find((f) => f.key === 'total_supply');
    assert.equal(supply?.status, 'unavailable');
    assert.equal(supply?.value, null);
  });

  test('ALWAYS_ALLOW is reported as "no restriction", not as a missing value', async () => {
    const { snapshot } = await inspect();
    const scope = snapshot.fields.find((f) => f.key === 'transfer_sender_policy');
    assert.equal(scope?.status, 'exact_chain_read');
    assert.match(scope?.value ?? '', /ALWAYS_ALLOW/);
  });

  test('an undocumented policy type is labelled as undocumented rather than named', async () => {
    const { snapshot } = await inspect(TOKEN, {
      overrides: { [B20_SELECTORS_V1.policyId]: { ok: true, value: `0x${word(2n << 56n)}`, raw: '' } },
    });
    const scope = snapshot.fields.find((f) => f.key === 'transfer_sender_policy');
    assert.match(scope?.value ?? '', /not documented in the Beryl spec/);
  });

  test('who holds the admin role is always an explicit gap, never a guess', async () => {
    const { snapshot, card } = await inspect();
    const admin = snapshot.fields.find((f) => f.key === 'admin_role_holder');
    // `not_enumerable`, not `unavailable`: no read failed here. The interface
    // has no method that could answer, so a retry or a faster endpoint would
    // produce exactly this row again.
    assert.equal(admin?.status, 'not_enumerable');
    assert.equal(admin?.value, null);
    assert.match(admin?.reason ?? '', /no way to list role holders/);
    assert.ok(card.unavailable.some((line) => /DEFAULT_ADMIN_ROLE/.test(line)));
  });

  test('a card whose every readable field was read is complete, not partial', async () => {
    // The two rows above are permanent. If they counted as gaps, `complete`
    // would be unreachable and the status would say the same thing about a
    // fully-read card and a throttled one.
    const { snapshot } = await inspect();
    assert.equal(snapshot.status, 'complete');
    assert.ok(snapshot.fields.some((field) => field.status === 'not_enumerable'));
  });

  test('one failed read is enough to make the same card partial', async () => {
    const { snapshot } = await inspect(TOKEN, {
      overrides: { [B20_SELECTORS_V1.pausedFeatures]: { ok: false, reason: 'rate_limited' } },
    });
    assert.equal(snapshot.status, 'partial');
    const paused = snapshot.fields.find((f) => f.key === 'paused_features');
    assert.equal(paused?.status, 'unavailable');
    assert.match(paused?.reason ?? '', /rate_limited/);
  });

  test('a paused feature ordinal beyond the documented enum stays unknown', async () => {
    const { snapshot } = await inspect(TOKEN, {
      overrides: { [B20_SELECTORS_V1.pausedFeatures]: { ok: true, value: arrayWord([0, 7]), raw: '' } },
    });
    const paused = snapshot.fields.find((f) => f.key === 'paused_features');
    assert.match(paused?.value ?? '', /transfer/);
    assert.match(paused?.value ?? '', /unknown feature #7/);
  });
});

describe('the card states facts and scores nothing', () => {
  test('no field, statement or key anywhere resembles a score', async () => {
    const { card } = await inspect();
    const serialised = JSON.stringify(card).toLowerCase();
    for (const banned of ['safety score', 'overall confidence', '/100', 'safe token', 'unsafe token', 'risk score']) {
      assert.equal(serialised.includes(banned), false, `the card must not contain ${banned}`);
    }
    // And no numeric grade smuggled in as a field.
    assert.equal('score' in (card as unknown as Record<string, unknown>), false);
  });

  test('control statements are capabilities with an observed state', async () => {
    const { card } = await inspect();
    const freeze = card.statements.find((s) => s.key === 'freeze_and_seize');
    assert.ok(freeze);
    assert.match(freeze.statement, /BURN_BLOCKED_ROLE/);
    assert.match(freeze.statement, /no access to any other asset/);
    // Nothing claims the issuer will take anyone's money.
    assert.equal(/will take|can steal|заберет/i.test(freeze.statement), false);
  });

  test('an open policy reads as unconstrained and a set policy as constrained', async () => {
    const open = await inspect();
    assert.equal(open.card.statements.find((s) => s.key === 'transfer_gating')?.observedState, 'unconstrained');

    const gated = await inspect(TOKEN, {
      overrides: { [B20_SELECTORS_V1.policyId]: { ok: true, value: `0x${word(5n)}`, raw: '' } },
    });
    assert.equal(gated.card.statements.find((s) => s.key === 'transfer_gating')?.observedState, 'constrained');
  });

  test('the boundaries are on the card, so what it does not cover is visible', async () => {
    const { card } = await inspect();
    const text = card.boundaries.join(' ');
    for (const topic of ['Holders', 'Liquidity', 'Vesting', 'sold']) {
      assert.match(text, new RegExp(topic, 'i'));
    }
  });

  test('renaming the token does not change its identity or its card hash', async () => {
    const first = await inspect();
    const renamed = await inspect(TOKEN, {
      overrides: {
        [B20_SELECTORS_V1.name]: { ok: true, value: stringWord('Renamed'), raw: '' },
        [B20_SELECTORS_V1.symbol]: { ok: true, value: stringWord('NEW'), raw: '' },
      },
    });
    assert.equal(first.card.identityHash, renamed.card.identityHash);
    assert.equal(
      first.card.identityHash,
      b20TokenIdentityHashV1({ chainId: 8453, tokenAddress: TOKEN }),
    );
    // The display fields differ, and the card hash does not move with them.
    assert.notEqual(first.card.displaySymbol, renamed.card.displaySymbol);
    assert.equal(
      hashB20CardV1({ ...first.card, displayName: 'x', displaySymbol: 'y' }),
      first.card.cardHash,
    );
  });
});

describe('the snapshot refuses to be inconsistent', () => {
  test('evidence read at another block is rejected by the schema', async () => {
    const { snapshot } = await inspect();
    const tampered = {
      ...snapshot,
      evidence: snapshot.evidence.map((record, index) =>
        index === 0 ? { ...record, blockNumber: '49059663' } : record,
      ),
    };
    assert.throws(() => B20ControlSnapshotV1Schema.parse(tampered), /snapshot block|evidenceHash/);
  });

  test('a block hash that does not match the snapshot is rejected', async () => {
    const { snapshot } = await inspect();
    const tampered = { ...snapshot, blockHash: `0x${'cd'.repeat(32)}` };
    assert.throws(() => B20ControlSnapshotV1Schema.parse(tampered), /snapshotHash|block hash/);
  });

  test('a field citing evidence that is not in the snapshot is rejected', async () => {
    const { snapshot } = await inspect();
    const tampered = {
      ...snapshot,
      fields: snapshot.fields.map((field) =>
        field.evidenceHash ? { ...field, evidenceHash: `0x${'11'.repeat(32)}` } : field,
      ),
    };
    assert.throws(() => B20ControlSnapshotV1Schema.parse(tampered));
  });

  test('a mutated card hash is rejected', async () => {
    const { card } = await inspect();
    assert.throws(() => B20ControlCardV1Schema.parse({ ...card, blockNumber: '1' }), /cardHash/);
  });

  test('a value on a row that has no value is rejected', async () => {
    const { snapshot } = await inspect();
    const tampered = {
      ...snapshot,
      // Every status other than an exact read, so the invariant is tested
      // rather than whichever statuses this fixture happens to produce.
      fields: snapshot.fields.map((field) =>
        field.status === 'exact_chain_read' ? field : { ...field, value: 'made up' },
      ),
    };
    assert.ok(
      tampered.fields.some((field) => field.value === 'made up'),
      'the fixture must contain at least one row without a value',
    );
    assert.throws(() => B20ControlSnapshotV1Schema.parse(tampered));
  });
});

describe('nothing credential-shaped escapes', () => {
  test('a URL in provider text is redacted before it can reach a log', () => {
    const text = redactRpcTextV1('failed calling https://base-mainnet.g.alchemy.com/v2/SECRETKEY oops');
    assert.equal(text.includes('SECRETKEY'), false);
    assert.equal(text.includes('alchemy'), false);
    assert.match(text, /<url>/);
  });

  test('no evidence record carries a URL, a key or raw response bytes', async () => {
    const { snapshot } = await inspect();
    const serialised = JSON.stringify(snapshot.evidence);
    assert.equal(/https?:\/\//.test(serialised), false);
    assert.equal(/apikey|api_key|secret/i.test(serialised), false);
    // The raw bytes are hashed, not stored.
    assert.ok(snapshot.evidence.every((record) => /^0x[0-9a-f]{64}$/.test(record.rawResponseHash)));
  });

  test('the reader opens no socket when it has no endpoint', async () => {
    const reader = createB20ReaderV1({
      rpcUrl: '   ',
      fetchImpl: () => {
        throw new Error('a unit test must never open a socket');
      },
    });
    const result = await reader.readBlockAnchor();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_configured');
  });

  test('the reader treats an empty eth_call result as empty, not as false', async () => {
    const reader = createB20ReaderV1({
      rpcUrl: 'https://rpc.example/key',
      fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' })),
    });
    const result = await reader.readIsB20(TOKEN, '0x1');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'empty_result');
  });

  test('a rate-limited endpoint is classified, not read as a verdict', async () => {
    const reader = createB20ReaderV1({
      rpcUrl: 'https://rpc.example/key',
      maxRetries: 0,
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'over rate limit' } })),
    });
    const result = await reader.readIsB20(TOKEN, '0x1');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'rate_limited');
  });

  test('a throttled read is repeated, and the repeat asks about the same block', async () => {
    // Repeating is only safe because the block tag is pinned: the retry asks
    // the identical question, so a card can never straddle two blocks.
    const blockTags: unknown[] = [];
    let attempts = 0;
    const reader = createB20ReaderV1({
      rpcUrl: 'https://rpc.example/key',
      sleepImpl: async () => {},
      fetchImpl: async (_url, init) => {
        attempts += 1;
        const body = JSON.parse(String((init as RequestInit).body)) as { params: unknown[] };
        blockTags.push(body.params[1]);
        return attempts < 3
          ? new Response('', { status: 429 })
          : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${'0'.repeat(63)}1` }));
      },
    });
    const result = await reader.readIsB20(TOKEN, '0x2ee894e');
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
    assert.deepEqual(new Set(blockTags), new Set(['0x2ee894e']));
  });

  test('a revert is never repeated, because it is an answer', async () => {
    let attempts = 0;
    const reader = createB20ReaderV1({
      rpcUrl: 'https://rpc.example/key',
      sleepImpl: async () => {},
      fetchImpl: async () => {
        attempts += 1;
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
        );
      },
    });
    const result = await reader.call({ to: TOKEN, data: '0x18160ddd', blockTag: '0x1' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'reverted');
    assert.equal(attempts, 1, 'a revert must cost exactly one call');
  });

  test('a throttle that never lifts gives up rather than hanging', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const reader = createB20ReaderV1({
      rpcUrl: 'https://rpc.example/key',
      maxRetries: 2,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        attempts += 1;
        return new Response('', { status: 429 });
      },
    });
    const result = await reader.readIsB20(TOKEN, '0x1');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'rate_limited');
    assert.equal(attempts, 3, 'the first call plus maxRetries repeats');
    // Backoff grows, and pacing has started spacing the calls out as well.
    assert.ok(waits.length >= 2, 'each repeat waited first');
    assert.ok(waits.some((ms) => ms >= 250), `expected a growing wait, got ${waits.join(', ')}`);
  });

  test('a Retry-After header is honoured, but only up to a few seconds', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const reader = createB20ReaderV1({
      rpcUrl: 'https://rpc.example/key',
      maxRetries: 1,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        attempts += 1;
        // An absurd value must not be able to stall the request.
        return new Response('', { status: 429, headers: { 'retry-after': attempts === 1 ? '2' : '9999' } });
      },
    });
    await reader.readIsB20(TOKEN, '0x1');
    assert.equal(waits[0], 2_000);
  });
});

describe('the card can be rebuilt from its snapshot', () => {
  test('rebuilding produces the identical card hash', async () => {
    const { snapshot, card } = await inspect();
    assert.equal(buildB20CardV1(snapshot).cardHash, card.cardHash);
  });
});
