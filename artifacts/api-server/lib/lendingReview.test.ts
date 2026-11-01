import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { materialLendingHealthBucketV1 } from './lendingReview.js';

const wad = (ratio: string) => (BigInt(Math.round(Number(ratio) * 1e6)) * 10n ** 12n).toString();

describe('a health ratio binds the signing terms only where a move of it is material', () => {
  it('binds hundredths below 100, and every ratio from 100 up as one', () => {
    assert.equal(materialLendingHealthBucketV1(wad('2.26'), '1000000'), '226');
    assert.notEqual(materialLendingHealthBucketV1(wad('2.26'), '1000000'), materialLendingHealthBucketV1(wad('2.27'), '1000000'));
    // A debt of three atomic units read 2,152,681.13 then 2,152,681.09 (2026-11-01): the same terms.
    assert.equal(materialLendingHealthBucketV1(wad('2152681.126303'), '3'), 'far');
    assert.equal(materialLendingHealthBucketV1(wad('2152681.088235'), '3'), 'far');
    assert.equal(materialLendingHealthBucketV1(wad('100'), '3'), 'far');
    assert.equal(materialLendingHealthBucketV1(wad('99.99'), '3'), '9999');
    // No debt, or the protocol's no-debt sentinel, binds nothing.
    assert.equal(materialLendingHealthBucketV1(wad('2'), '0'), null);
    assert.equal(materialLendingHealthBucketV1((1n << 128n).toString(), '3'), null);
  });
});
