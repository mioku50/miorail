import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spendCallingCodeV1, spendPhoneV1 } from '../src/index.js';

// The numbers here are made up in each country's shape; none is anyone's.
describe('a top-up number is sent only as a number of the operator’s country', () => {
  it('reads the international format however it is written', () => {
    for (const written of ['+91 98765 43210', '0091 98765-43210', '(+91) 98765.43210', '919876543210', '+91\u00a098765\u00a043210']) {
      assert.equal(spendPhoneV1(written, 'IN'), '919876543210', written);
    }
    assert.equal(spendPhoneV1('+234 803 123 4567', 'NG'), '2348031234567');
    assert.equal(spendPhoneV1('+63 917 123 4567', 'ph'), '639171234567');
  });

  it('refuses a local number without its code, a number of another country, and anything that is no number', () => {
    for (const written of ['98765 43210', '+1 202 555 0100', '+91 12', '+91 98765 43210 98765', 'call me', '+91 98765 4321O', '']) {
      assert.equal(spendPhoneV1(written, 'IN'), null, written);
    }
    assert.equal(spendPhoneV1('+91 98765 43210', null), null);
    assert.equal(spendPhoneV1('+91 98765 43210', 'XX'), null);
    assert.equal(spendPhoneV1(`+91${'1'.repeat(40)}`, 'IN'), null);
  });

  it('tells apart the countries that share a calling code', () => {
    // Kazakhstan and Russia share +7; the area codes of the North American plan share +1.
    assert.equal(spendPhoneV1('+7 777 123 4567', 'KZ'), '77771234567');
    assert.equal(spendPhoneV1('+7 912 345 6789', 'KZ'), null);
    assert.equal(spendPhoneV1('+7 912 345 6789', 'RU'), '79123456789');
    assert.equal(spendPhoneV1('8 777 123 4567', 'KZ'), null);
    assert.equal(spendPhoneV1('+1 809 555 0100', 'DO'), '18095550100');
    assert.equal(spendPhoneV1('+1 202 555 0100', 'DO'), null);
    assert.equal(spendPhoneV1('+1 202 555 0100', 'US'), '12025550100');
  });

  it('names the code a person writes first', () => {
    assert.deepEqual(['IN', 'kz', 'DO', 'GB', 'XX'].map(spendCallingCodeV1), ['91', '7', '1', '44', null]);
    assert.equal(spendCallingCodeV1(null), null);
  });
});
