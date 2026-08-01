import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  builderCodeAdviceV1,
  builderCodeFromEnvV1,
  resolveBuilderCodeV1,
} from '../src/builder-code.js';

// T67X-B1 — one value, three env names, and one rule about what happens when
// they disagree. Attribution failures are silent by design (the chain does not
// reject an unattributed transaction), so every branch here is a branch that
// would otherwise go unnoticed in production.

describe('resolving the Builder Code', () => {
  test('the canonical key wins and reports itself', () => {
    const resolution = resolveBuilderCodeV1({ BASE_BUILDER_CODE: 'bc_a1b2c3d4' });
    assert.deepEqual(resolution, {
      status: 'resolved',
      code: 'bc_a1b2c3d4',
      source: 'canonical',
      key: 'BASE_BUILDER_CODE',
      deprecatedKeys: [],
    });
    assert.equal(builderCodeAdviceV1(resolution), null);
  });

  test('the deprecated alias still works, and says so', () => {
    // A deployment that pulls this change must not lose attribution before the
    // operator has renamed anything.
    const resolution = resolveBuilderCodeV1({ BUILDER_CODE: 'miorail' });
    assert.equal(resolution.status, 'resolved');
    assert.equal(builderCodeFromEnvV1({ BUILDER_CODE: 'miorail' }), 'miorail');
    assert.match(builderCodeAdviceV1(resolution)!, /deprecated/);
    assert.match(builderCodeAdviceV1(resolution)!, /BASE_BUILDER_CODE/);
  });

  test('both set to the same value is agreement, not a conflict', () => {
    const resolution = resolveBuilderCodeV1({
      BASE_BUILDER_CODE: 'bc_a1b2c3d4',
      BUILDER_CODE: 'bc_a1b2c3d4',
    });
    assert.equal(resolution.status, 'resolved');
    assert.equal(resolution.status === 'resolved' && resolution.source, 'canonical');
    assert.deepEqual(resolution.status === 'resolved' && resolution.deprecatedKeys, ['BUILDER_CODE']);
    assert.match(builderCodeAdviceV1(resolution)!, /can be deleted/);
  });

  test('both set to DIFFERENT values fails closed', () => {
    // Not "the canonical one wins": an operator who wrote two different codes
    // does not know which one they meant, and silently crediting one of them is
    // a decision this module has no basis to make.
    const resolution = resolveBuilderCodeV1({
      BASE_BUILDER_CODE: 'bc_a1b2c3d4',
      BUILDER_CODE: 'bc_deadbeef',
    });
    assert.equal(resolution.status, 'conflict');
    assert.equal(
      builderCodeFromEnvV1({ BASE_BUILDER_CODE: 'bc_a1b2c3d4', BUILDER_CODE: 'bc_deadbeef' }),
      undefined,
    );
    assert.match(builderCodeAdviceV1(resolution)!, /different values/);
  });

  test('the conflict rule holds across surface prefixes', () => {
    assert.equal(
      resolveBuilderCodeV1({ VITE_BASE_BUILDER_CODE: 'bc_one', VITE_BUILDER_CODE: 'bc_two' }).status,
      'conflict',
    );
    assert.equal(
      resolveBuilderCodeV1({ NEXT_PUBLIC_BASE_BUILDER_CODE: 'bc_one', BUILDER_CODE: 'bc_one' }).status,
      'resolved',
    );
  });

  test('a placeholder is not a code', () => {
    const resolution = resolveBuilderCodeV1({ BASE_BUILDER_CODE: 'your_builder_code' });
    assert.deepEqual(resolution, { status: 'invalid', key: 'BASE_BUILDER_CODE', reason: 'placeholder' });
  });

  test('a malformed code is refused rather than passed to the wallet', () => {
    // ox would throw on it at suffix time, inside a render; refusing here keeps
    // the failure in configuration where it can be read.
    assert.equal(resolveBuilderCodeV1({ BASE_BUILDER_CODE: 'BC-Upper Case' }).status, 'invalid');
    assert.equal(resolveBuilderCodeV1({ BASE_BUILDER_CODE: 'x'.repeat(33) }).status, 'invalid');
  });

  test('whitespace-only and unset are the same absence', () => {
    assert.equal(resolveBuilderCodeV1({}).status, 'absent');
    assert.equal(resolveBuilderCodeV1({ BASE_BUILDER_CODE: '   ' }).status, 'absent');
    assert.equal(resolveBuilderCodeV1({ BUILDER_CODE: '' }).status, 'absent');
    assert.match(builderCodeAdviceV1(resolveBuilderCodeV1({}))!, /attributed to nobody/);
  });

  test('the resolver reads nothing global', () => {
    const before = process.env.BASE_BUILDER_CODE;
    process.env.BASE_BUILDER_CODE = 'bc_from_process';
    try {
      assert.equal(resolveBuilderCodeV1({}).status, 'absent');
    } finally {
      if (before === undefined) delete process.env.BASE_BUILDER_CODE;
      else process.env.BASE_BUILDER_CODE = before;
    }
  });
});
