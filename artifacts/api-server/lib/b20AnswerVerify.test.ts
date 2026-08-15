import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { numbersInV1, verifyB20NarrationV1, B20_NARRATION_MAX_CHARS_V1 } from './b20AnswerVerify.js';

// ---------------------------------------------------------------------------
// The one component whose job is to be wrong in the safe direction.
//
// A rejected narration falls back to the deterministic sentence that shipped
// before any model was involved, so over-rejection costs a nicer paragraph.
// Under-rejection costs a fluent, plausible number that nobody measured,
// published under Miorail's name. These tests are written from that asymmetry.
// ---------------------------------------------------------------------------

const EVIDENCE = [
  'Round trip',
  '1.3%',
  'Exit capacity',
  'at least 4,000,000 WORM · fails by 8,000,000 WORM',
  'Bought at launch',
  '62 wallets · largest 12.00%',
  'Measured at',
  'block 49929328',
];

const verify = (narration: string, evidence: readonly string[] = EVIDENCE) =>
  verifyB20NarrationV1({ narration, evidence });

describe('numbers are normalised so formatting cannot hide a mismatch', () => {
  test('thousands separators and trailing zeros collapse', () => {
    assert.deepEqual(numbersInV1('1,139 and 3.00 and 0.50'), ['1139', '3', '0.5']);
  });

  test('a leading decimal point is the same number as a leading zero', () => {
    assert.deepEqual(numbersInV1('.5'), ['0.5']);
  });

  test('a minus sign is kept, because a negative cost is a different claim', () => {
    assert.deepEqual(numbersInV1('-12'), ['-12']);
  });

  test('an atomic amount too large for a double keeps its digits', () => {
    // 4,000,000,000,000,000,000,000 wei is an ordinary B20 figure and rounds
    // as a double. Losing the digits would let a wrong number verify.
    assert.deepEqual(numbersInV1('4000000000000000000000'), ['4000000000000000000000']);
  });
});

describe('every number in the answer must be in the evidence', () => {
  test('a quoted figure passes', () => {
    assert.equal(verify('The round trip measured 1.3% and 62 wallets bought at launch.').ok, true);
  });

  test('the same figure written differently still passes', () => {
    // The bundle says "1.3%"; "1.30%" is the same measurement.
    assert.equal(verify('Round trip 1.30%.').ok, true);
  });

  test('a rounded figure is refused', () => {
    // "about 1%" is not the measurement, and a reader cannot tell that it was
    // rounded rather than measured.
    const verdict = verify('The round trip is about 1%.');
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations.join(' '), /numbers not present/);
  });

  test('a derived figure is refused even when the arithmetic is right', () => {
    // 62 wallets and 12% largest share does not license "about 7 wallets held
    // the top share". Arithmetic nobody checked is arithmetic nobody measured.
    assert.equal(verify('Roughly 7 wallets took the largest share.').ok, false);
  });

  test('a figure from the wrong bundle is refused', () => {
    assert.equal(verify('62 wallets bought this.', ['Bought at launch', '4 wallets']).ok, false);
  });

  test('prose with no numbers passes', () => {
    assert.equal(verify('Miorail could price a purchase but not a sale.').ok, true);
  });
});

describe('vocabulary and overclaim', () => {
  test('recommendation words are refused however true the numbers are', () => {
    const verdict = verify('Round trip 1.3%, which makes this a good opportunity.');
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations.join(' '), /vocabulary/);
  });

  test('accusation words are refused too', () => {
    assert.equal(verify('No sale priced — this is a honeypot.').ok, false);
    assert.equal(verify('This token is a scam.').ok, false);
  });

  test('a claim about what the reader will be able to do is refused', () => {
    const verdict = verify('You will be able to sell at 1.3%.');
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations.join(' '), /claims an outcome/);
  });

  test('a negative statement is NOT an overclaim', () => {
    // The rule is about claiming outcomes, not about being discouraging. The
    // more negative sentence is the one this product exists to publish.
    assert.equal(verify('Miorail could not price a sale at the reference size.').ok, true);
  });

  test('"unsafe" is refused as firmly as "safe"', () => {
    assert.equal(verify('This looks unsafe.').ok, false);
  });
});

describe('shape', () => {
  test('an empty narration is refused rather than shown as an answer', () => {
    assert.equal(verify('   ').ok, false);
  });

  test('a narration that runs long is refused', () => {
    const verdict = verify('Miorail measured the pool. '.repeat(60));
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations.join(' '), new RegExp(String(B20_NARRATION_MAX_CHARS_V1)));
  });

  test('violations are reported together, not one at a time', () => {
    // An operator reading the log should see everything wrong with one answer.
    const verdict = verify('This safe token returns about 99% and you will be able to sell.');
    assert.equal(verdict.ok, false);
    assert.ok(verdict.violations.length >= 3, `expected several violations, got ${verdict.violations.length}`);
  });
});

describe('formatting a card cannot render is stripped, not rejected', () => {
  test('bold survives as its own words', () => {
    // Observed live: the provider returned "found an **entry route**", and the
    // Discover card renders plain text, so the asterisks would have shipped.
    const verdict = verify('Miorail found an **entry route** and no sale priced.');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.narration, 'Miorail found an entry route and no sale priced.');
  });

  test('inline code and headings go too', () => {
    assert.equal(verify('## Summary\nThe reason is `no_exit_route`.').narration, 'Summary\nThe reason is no_exit_route.');
  });

  test('a bullet keeps its line rather than losing it', () => {
    assert.match(verify('- Round trip 1.3%\n- 62 wallets').narration, /• Round trip 1\.3%/);
  });

  test('stripping cannot smuggle a number past the check', () => {
    // The verdict carries the string that will be SHOWN, so a caller cannot
    // verify one text and display another.
    const verdict = verify('The round trip was **2.4%**.');
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations.join(' '), /2\.4/);
  });
});

describe('a Russian-formatted number is one number', () => {
  test('a space-separated thousands group is joined', () => {
    // Measured live 2026-08-15: the provider answered in Russian and wrote
    // "49 929 328". It arrived as 49, 929 and 328 — none of them in the
    // evidence — so a correct answer was rejected for its punctuation.
    assert.deepEqual(numbersInV1('блок 49 929 328'), ['49929328']);
    assert.deepEqual(numbersInV1('1 139 запусков'), ['1139']);
  });

  test('a non-breaking and a thin space count too', () => {
    assert.deepEqual(numbersInV1('49 929 328'), ['49929328']);
    assert.deepEqual(numbersInV1('49 929 328'), ['49929328']);
  });

  test('separate small numbers are NOT merged', () => {
    // The joining rule is exact groups of three, so ordinary prose keeps its
    // numbers apart. Merging here would be the dangerous direction.
    assert.deepEqual(numbersInV1('3 4 5'), ['3', '4', '5']);
    assert.deepEqual(numbersInV1('62 wallets and 12 more'), ['62', '12']);
  });

  test('a Russian answer quoting the block verifies', () => {
    assert.equal(verify('Измерено на блоке 49 929 328, продажа не оценена.').ok, true);
  });
});
