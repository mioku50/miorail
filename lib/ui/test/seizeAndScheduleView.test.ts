import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { seizeViewV1 } from '../src/console/seizeView';
import { multiplierScheduleViewV1, multiplierDecimalV1 } from '../src/console/multiplierScheduleView';

const HOLDER = '0x1111111111111111111111111111111111111111';
const TREASURY = '0x2222222222222222222222222222222222222222';
const ONE = (10n ** 18n).toString();
const TWO = (2n * 10n ** 18n).toString();

function allText(view: NonNullable<ReturnType<typeof seizeViewV1>>): string {
  return [...view.capability.lines, ...view.occurrences.lines].map((line) => line.text).join(' ');
}

describe('administrative seizure, as a reader sees it', () => {
  test('capability and occurrence are two sections, never one sentence', () => {
    const view = seizeViewV1({
      configuration: {
        surface: 'available',
        arming: 'armed',
        pause: 'not_paused',
        holder: { address: HOLDER, outcome: 'seizable' },
        receiver: { address: TREASURY, outcome: 'permitted' },
      },
      occurrences: { events: [], fromBlock: 49_145_000, toBlock: 51_500_000 },
    })!;
    assert.equal(view.capability.title, 'Administrative seizure');
    assert.equal(view.occurrences.title, 'Seizures on record');
    // Configured and never used is the ordinary state of a regulated asset,
    // and the screen says both halves rather than implying one from the other.
    assert.match(view.occurrences.lines[0]!.text, /No seizure has been recorded/);
    assert.match(view.capability.lines.map((l) => l.text).join(' '), /could move this balance/);
  });

  test('a protected address is never described with the word the policy uses', () => {
    // `isAuthorized` answering true on the exemption slot means the holder
    // CANNOT be seized. Printing "authorized" would say the opposite.
    const view = seizeViewV1({
      configuration: {
        surface: 'available',
        arming: 'armed',
        pause: 'not_paused',
        holder: { address: HOLDER, outcome: 'exempt' },
      },
    })!;
    const text = allText(view);
    assert.match(text, /cannot seize from it/);
    assert.doesNotMatch(text, /authorized/i);
  });

  test('no single verdict, and no colour that would be one', () => {
    const view = seizeViewV1({
      configuration: {
        surface: 'available',
        arming: 'armed',
        pause: 'not_paused',
        holder: { address: HOLDER, outcome: 'seizable' },
      },
    })!;
    const text = allText(view);
    // Neither of the two sentences this section must never produce.
    assert.doesNotMatch(text, /your tokens are safe|cannot be taken|will be taken/i);
    // A holder-relevant fact may be `warn`; nothing here is `bad`, because a
    // published property of a regulated instrument is not a fault.
    const tones = new Set([...view.capability.lines, ...view.occurrences.lines].map((l) => l.tone));
    assert.equal(tones.has('off'), false);
    // And the precondition we cannot read is said out loud.
    assert.match(text, /who holds the issuer’s seize role/);
  });

  test('an unconfigured token says nobody is seizable, not that nobody looked', () => {
    const view = seizeViewV1({
      configuration: { surface: 'available', arming: 'unconfigured', pause: 'not_paused' },
    })!;
    assert.match(view.capability.lines[0]!.text, /has not set up seizure/);
    assert.match(view.capability.lines[0]!.text, /no address can be seized/);
  });

  test('a deployment without the function is not a token that was not read', () => {
    const missing = seizeViewV1({ configuration: { surface: 'not_on_this_deployment' } })!;
    const unread = seizeViewV1({ configuration: { surface: 'not_established' } })!;
    assert.match(missing.capability.lines[0]!.text, /has no administrative seizure function/);
    assert.match(unread.capability.lines[0]!.text, /could not read whether/);
    assert.notEqual(missing.capability.lines[0]!.text, unread.capability.lines[0]!.text);
  });

  test('an unread history is not an empty one', () => {
    const view = seizeViewV1({
      configuration: { surface: 'available', arming: 'armed', pause: 'not_paused' },
      occurrences: null,
    })!;
    assert.match(view.occurrences.lines[0]!.text, /has not read this contract’s seizure history/);
    assert.doesNotMatch(view.occurrences.lines[0]!.text, /No seizure has been recorded/);
  });
});

describe('the multiplier a holder converts with', () => {
  test('a scheduled change never becomes the effective sentence', () => {
    const view = multiplierScheduleViewV1({
      effectiveMultiplierWad: ONE,
      scheduled: [
        { state: 'scheduled', multiplierWad: TWO, effectiveAt: '2026-10-05T14:00:00.000Z' },
      ],
    })!;
    assert.match(view.effective.text, /one token represents one underlying share/i);
    assert.doesNotMatch(view.effective.text, /2/);
    assert.equal(view.scheduled.length, 1);
    // The plan carries its date AND the fact that it is not in force. A reader
    // who takes half the sentence must not be able to take the wrong half.
    assert.match(view.scheduled[0]!.text, /2026-10-05/);
    assert.match(view.scheduled[0]!.text, /not in force yet/);
  });

  test('nothing read is not a multiplier of one', () => {
    const view = multiplierScheduleViewV1({
      effectiveMultiplierWad: null,
      scheduled: [
        { state: 'scheduled', multiplierWad: TWO, effectiveAt: '2026-10-05T14:00:00.000Z' },
      ],
    })!;
    assert.match(view.effective.text, /has not read/);
    // And above all: the plan's number does not fill the gap.
    assert.doesNotMatch(view.effective.text, /2/);
  });

  test('a withdrawn plan says it did not happen', () => {
    const view = multiplierScheduleViewV1({
      effectiveMultiplierWad: ONE,
      history: [
        {
          state: 'not_executed_as_planned',
          cause: 'cancelled',
          multiplierWad: TWO,
          effectiveAt: '2026-10-05T14:00:00.000Z',
        },
        {
          state: 'not_executed_as_planned',
          cause: 'superseded',
          multiplierWad: '1500000000000000000',
          effectiveAt: '2026-10-09T14:00:00.000Z',
        },
      ],
    })!;
    assert.equal(view.notExecuted.length, 2);
    assert.match(view.notExecuted[0]!.text, /withdrew it\. It did not happen\./);
    assert.match(view.notExecuted[1]!.text, /replaced before it took effect\. It did not happen\./);
    assert.equal(view.scheduled.length, 0);
  });

  test('an unconfirmed change is in neither list', () => {
    // The date passed and nobody has read the token. That is a gap in our
    // reading, and the instrument sentences stay silent about it rather than
    // rounding it to "scheduled" or to "in force".
    const view = multiplierScheduleViewV1({
      effectiveMultiplierWad: null,
      history: [
        { state: 'awaiting_confirmation', multiplierWad: TWO, effectiveAt: '2026-10-05T14:00:00.000Z' },
      ],
    })!;
    assert.equal(view.scheduled.length, 0);
    assert.equal(view.notExecuted.length, 0);
  });

  test('the WAD is rendered by decimal arithmetic, not by a float', () => {
    // The real GOOGLc value, read on 2026-09-14. A float loses the last digits,
    // and those digits are the difference between a share count that
    // reconciles and one that does not.
    assert.equal(multiplierDecimalV1('1000377118676784179'), '1.000377118676784179');
    assert.equal(multiplierDecimalV1(ONE), '1.000000000000000000');
    assert.equal(multiplierDecimalV1('nonsense'), null);

    const view = multiplierScheduleViewV1({ effectiveMultiplierWad: '1000377118676784179' })!;
    assert.match(view.effective.text, /1\.000377118676784179 underlying shares/);
  });
});
