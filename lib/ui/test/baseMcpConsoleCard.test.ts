import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BASE_MCP_CONSOLE_PROMPTS_V1,
  baseMcpConsoleStatusCopyV1,
  baseMcpConsoleTraceSummaryV1,
  type BaseMcpConsoleAnswerV1,
} from '../src/console/BaseMcpConsoleCard';

const answer = (overrides: Partial<BaseMcpConsoleAnswerV1> = {}): BaseMcpConsoleAnswerV1 => ({
  status: 'answered',
  reply: 'Here is what the tools returned.',
  trace: [{ tool: 'get_portfolio', args: '{}', ok: true, result: '{}', errorCode: null }],
  toolsAvailable: 12,
  truncated: false,
  errorCode: null,
  ...overrides,
});

describe('the console never borrows the routers’ authority', () => {
  test('no starter prompt asks for something the console refuses', () => {
    // A chip offering "swap 10 USDC" would advertise a capability this surface
    // does not have, and the refusal would read as a bug rather than a rule.
    for (const prompt of BASE_MCP_CONSOLE_PROMPTS_V1) {
      assert.doesNotMatch(prompt, /\b(swap|send|approve|sign|buy|sell)\b/i, prompt);
    }
  });

  test('an empty Base MCP inventory is stated as a connection fact', () => {
    const copy = baseMcpConsoleStatusCopyV1(answer({ status: 'no_tools' }))!;
    assert.match(copy, /not about Base/i);
    // The recurring defect: our own broken connection rendered as a finding
    // about the subject.
    assert.doesNotMatch(copy, /Base has no|Base does not offer/i);
  });

  test('a failure is not a claim about what Base MCP can do', () => {
    assert.match(baseMcpConsoleStatusCopyV1(answer({ status: 'failed' }))!, /Nothing here is a statement/i);
  });

  test('an expired session says to connect, not that Base MCP is broken', () => {
    assert.match(baseMcpConsoleStatusCopyV1(answer({ status: 'needs_reauth' }))!, /expired/i);
  });

  test('a completed answer adds no status line of its own', () => {
    assert.equal(baseMcpConsoleStatusCopyV1(answer()), null);
  });
});

describe('the trace summary says where the words came from', () => {
  test('a call count and the failures within it', () => {
    const summary = baseMcpConsoleTraceSummaryV1(answer({
      trace: [
        { tool: 'a', args: '{}', ok: true, result: '{}', errorCode: null },
        { tool: 'b', args: '{}', ok: false, result: '{}', errorCode: 'base_mcp_timeout' },
      ],
    }));
    assert.match(summary, /2 Base MCP tool calls/);
    assert.match(summary, /1 failed/);
  });

  test('an answer with no tool call says so plainly', () => {
    // This is the case a reader most needs flagged: a fluent paragraph that no
    // third-party tool actually supplied.
    const summary = baseMcpConsoleTraceSummaryV1(answer({ trace: [] }));
    assert.match(summary, /No tool was called/i);
    assert.match(summary, /no Base MCP data/i);
  });

  test('a single call is not called "1 tool calls"', () => {
    assert.match(baseMcpConsoleTraceSummaryV1(answer()), /1 Base MCP tool call\./);
  });
});
