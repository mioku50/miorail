import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { B20_PIPELINE_STATES_V1 } from '@mioagent/opportunity-rail';
import { B20PipelineStateV1Schema } from '@mioagent/api-zod';

// The wire enum used to be a hand-kept copy of the producer's list. They
// drifted: `feed_frozen` reached the producer, the console vocabulary and the
// route, but never the schema — so for as long as the operator kept the launch
// feed frozen, GET /opportunities/b20 and /opportunities/b20/market/rails
// answered 500 with `invalid_enum_value`, and the screen said Discover storage
// had not answered. Storage had answered; the schema could not carry the word.
//
// The schema is derived now, so this cannot drift again by editing one list.
// The test stays because the derivation is what must not be undone: anyone who
// retypes the enum as a literal fails here rather than in production, on the
// day an operator uses a state that has existed for months.
describe('the B20 pipeline states a surface can be told', () => {
  test('every state the producer can emit passes the wire schema', () => {
    for (const state of B20_PIPELINE_STATES_V1) {
      assert.equal(
        B20PipelineStateV1Schema.safeParse(state).success,
        true,
        `${state} is producible but not serialisable`,
      );
    }
  });

  test('the frozen feed is one of them', () => {
    // Named on its own: it is the state that actually broke production, and a
    // loop over a list would still pass if the list itself lost the entry.
    assert.equal(B20PipelineStateV1Schema.safeParse('feed_frozen').success, true);
    assert.ok(B20_PIPELINE_STATES_V1.includes('feed_frozen'));
  });

  test('the schema is still an enum, not a free string', () => {
    assert.equal(B20PipelineStateV1Schema.safeParse('healthy_ish').success, false);
    assert.equal(B20PipelineStateV1Schema.safeParse('').success, false);
  });
});
