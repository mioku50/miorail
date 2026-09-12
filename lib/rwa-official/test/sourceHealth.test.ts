import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { officialSourceRegressionsV1 } from '../src/sourceHealth.js';

const NOW = '2026-09-12T09:00:00.000Z';
const ONE_HOUR_AGO = '2026-09-12T08:00:00.000Z';
const THREE_DAYS_AGO = '2026-09-09T09:00:00.000Z';

describe('a reviewed source that stopped answering', () => {
  test('an unparsable document fails the pass the first time', () => {
    // It was read. A document whose shape we no longer understand does not
    // recover on the next timer, so waiting a day to say so wastes a day.
    const lines = officialSourceRegressionsV1({
      now: NOW,
      checks: [
        {
          sourceKind: 'base_docs_technical',
          status: 'unparsable',
          detail: 'contract_address_table_missing: the document carries neither',
          lastSuccessAt: ONE_HOUR_AGO,
        },
      ],
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /base_docs_technical/);
    assert.match(lines[0]!, /contract_address_table_missing/);
  });

  test('one unreachable pass is a blip and says nothing', () => {
    const lines = officialSourceRegressionsV1({
      now: NOW,
      checks: [
        {
          sourceKind: 'backed_assets_api',
          status: 'unreachable',
          detail: 'fetch failed',
          lastSuccessAt: ONE_HOUR_AGO,
        },
      ],
    });
    assert.deepEqual(lines, []);
  });

  test('a source dark for a day is no longer a blip', () => {
    const lines = officialSourceRegressionsV1({
      now: NOW,
      checks: [
        {
          sourceKind: 'backed_assets_api',
          status: 'unreachable',
          detail: 'fetch failed',
          lastSuccessAt: THREE_DAYS_AGO,
        },
      ],
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /72h ago/);
  });

  test('a source that has never been read is dark, not new', () => {
    const lines = officialSourceRegressionsV1({
      now: NOW,
      checks: [
        { sourceKind: 'base_product_list', status: 'unreachable', detail: null, lastSuccessAt: null },
      ],
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /never read successfully/);
  });

  test('every source answering is silence', () => {
    const lines = officialSourceRegressionsV1({
      now: NOW,
      checks: [
        { sourceKind: 'base_docs_technical', status: 'ok', detail: null, lastSuccessAt: NOW },
        { sourceKind: 'base_product_list', status: 'ok', detail: null, lastSuccessAt: NOW },
      ],
    });
    assert.deepEqual(lines, []);
  });
});
