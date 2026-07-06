import { test } from 'node:test';
import assert from 'node:assert';
import { builderCodeToDataSuffix, resetAttributionWarningForTest } from './attribution';

test('builderCodeToDataSuffix handles valid codes', () => {
  resetAttributionWarningForTest();
  const suffix = builderCodeToDataSuffix('bc_12345678');
  assert.ok(suffix);
  assert.equal(typeof suffix, 'string');
  assert.ok(suffix.startsWith('0x'));
});

test('builderCodeToDataSuffix returns undefined for missing, empty, or placeholder codes', () => {
  resetAttributionWarningForTest();
  assert.equal(builderCodeToDataSuffix(undefined), undefined);
  assert.equal(builderCodeToDataSuffix(''), undefined);
  assert.equal(builderCodeToDataSuffix('placeholder'), undefined);
  assert.equal(builderCodeToDataSuffix('miorail-placeholder'), undefined);
  assert.equal(builderCodeToDataSuffix('TODO'), undefined);
  assert.equal(builderCodeToDataSuffix('YOUR_BUILDER_CODE'), undefined);
});

test('builderCodeToDataSuffix returns undefined and never throws when Attribution.toDataSuffix throws', () => {
  resetAttributionWarningForTest();
  const res = builderCodeToDataSuffix('bc_bad_code', () => {
    throw new Error('Simulated ERC-8021 format error');
  });
  assert.equal(res, undefined);
});
