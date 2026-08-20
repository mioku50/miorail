import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BASE_MCP_CONSOLE_PROMPTS_V1,
  BASE_MCP_QUICK_EXAMPLES_V1,
  BaseMcpConsoleCard,
  baseMcpConsoleStatusCopyV1,
  baseMcpToolSummaryV1,
  baseMcpConsoleTraceSummaryV1,
  type BaseMcpConsoleAnswerV1,
} from '../src/console/BaseMcpConsoleCard';

const answer = (overrides: Partial<BaseMcpConsoleAnswerV1> = {}): BaseMcpConsoleAnswerV1 => ({
  status: 'answered',
  reply: 'Here is what the tools returned.',
  trace: [{ tool: 'get_portfolio', args: '{}', ok: true, result: '{}', errorCode: null }],
  toolsAvailable: 12,
  truncated: false,
  elapsedMs: 0,
  errorCode: null,
  ...overrides,
});

test('an ACTION renders an approval card and states that it is not a Route Proof', () => {
  const html = renderToStaticMarkup(BaseMcpConsoleCard({
    question: 'Send 5 USDC',
    onQuestionChange: () => undefined,
    onAsk: () => undefined,
    pending: false,
    unavailableReason: null,
    answer: answer({
      status: 'action',
      trace: [],
      action: {
        approvalUrl: 'https://keys.coinbase.com/approve/test',
        receipt: {
          id: 'action-1',
          status: 'approval_required',
          actionType: 'send',
          provider: 'base-mcp',
          chainId: 8453,
          asset: { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
          amount: '5',
          recipient: '0x2222222222222222222222222222222222222222',
          reconciliationState: 'not_started',
          transactionHash: null,
          blockNumber: null,
          errorCode: null,
          routeVerified: false,
          reconciliationBasis: 'erc20_transfer_event',
        },
      },
    }),
  }));
  assert.match(html, /Action Receipt/);
  assert.match(html, /Approve in Base Account/);
  assert.match(html, /not a Miorail verified route/i);
  assert.doesNotMatch(html, /Execution proof/);
});

test('a reviewed Virtuals action labels the approval as sign-in and shows agent facts', () => {
  const html = renderToStaticMarkup(BaseMcpConsoleCard({
    question: 'Create a Virtuals agent called Mio Researcher to summarize Base research',
    onQuestionChange: () => undefined,
    onAsk: () => undefined,
    pending: false,
    unavailableReason: null,
    answer: answer({
      status: 'action',
      trace: [],
      action: {
        approvalUrl: 'https://keys.coinbase.com/approve/virtuals-sign-1',
        receipt: {
          id: 'virtuals-1',
          status: 'approval_required',
          actionType: 'virtuals',
          extensionProvider: 'virtuals',
          provider: 'base-mcp',
          chainId: 8453,
          operation: 'agent_create',
          agentName: 'Mio Researcher',
          agentDescription: 'summarize Base research',
          providerObjectId: null,
          reconciliationState: 'not_started',
          transactionHash: null,
          blockNumber: null,
          errorCode: null,
          routeVerified: false,
          reconciliationBasis: 'virtuals_provider_response',
        },
      },
    }),
  }));
  assert.match(html, /Approve Sign-In/);
  assert.match(html, /Mio Researcher/);
  assert.match(html, /summarize Base research/);
  assert.doesNotMatch(html, /Approve in Base Account/);
});

test('a failed deterministic action still renders its immutable receipt', () => {
  const failedWithReceipt = answer({
    status: 'failed',
    reply: 'That request ID is already bound to different action facts.',
    trace: [],
    errorCode: 'base_mcp_action_idempotency_conflict',
    action: {
      approvalUrl: null,
      receipt: {
        id: 'action-conflict',
        status: 'approval_required',
        actionType: 'send',
        provider: 'base-mcp',
        chainId: 8453,
        asset: { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
        amount: '5',
        recipient: '0x2222222222222222222222222222222222222222',
        reconciliationState: 'not_started',
        transactionHash: null,
        blockNumber: null,
        errorCode: null,
        routeVerified: false,
        reconciliationBasis: 'erc20_transfer_event',
      },
    },
  });
  const html = renderToStaticMarkup(BaseMcpConsoleCard({
    question: 'Send 6 USDC',
    onQuestionChange: () => undefined,
    onAsk: () => undefined,
    pending: false,
    unavailableReason: null,
    answer: failedWithReceipt,
  }));

  assert.equal(baseMcpConsoleStatusCopyV1(failedWithReceipt), null);
  assert.match(html, /Action Receipt/);
  assert.match(html, /different action facts/);
  assert.doesNotMatch(html, /The console could not complete that/);
});

test('a Basename send shows both the human name and resolved Base address', () => {
  const html = renderToStaticMarkup(BaseMcpConsoleCard({
    question: 'Send 5 USDC to mioku.base.eth',
    onQuestionChange: () => undefined,
    onAsk: () => undefined,
    pending: false,
    unavailableReason: null,
    answer: answer({
      status: 'action', trace: [],
      action: {
        approvalUrl: null,
        receipt: {
          id: 'action-name', status: 'approval_required', actionType: 'send',
          provider: 'base-mcp', chainId: 8453,
          asset: { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
          amount: '5', recipientName: 'mioku.base.eth',
          recipient: '0x2222222222222222222222222222222222222222',
          reconciliationState: 'not_started', transactionHash: null, blockNumber: null,
          errorCode: null, routeVerified: false, reconciliationBasis: 'erc20_transfer_event',
        },
      },
    }),
  }));
  assert.match(html, /mioku\.base\.eth/);
  assert.match(html, /Resolved Base address/);
  assert.match(html, /0x2222222222222222222222222222222222222222/);
});

test('a ROUTABLE response offers Routes AI and no approval URL', () => {
  const html = renderToStaticMarkup(BaseMcpConsoleCard({
    question: 'Swap 100 USDC to ETH',
    onQuestionChange: () => undefined,
    onAsk: () => undefined,
    onOpenRoutes: () => undefined,
    pending: false,
    unavailableReason: null,
    answer: answer({
      status: 'handoff',
      trace: [],
      handoff: { target: 'routes', path: '/routes', originalMessage: 'Swap 100 USDC to ETH' },
    }),
  }));
  assert.match(html, /ROUTABLE/);
  assert.match(html, /Open Routes AI/);
  assert.doesNotMatch(html, /Approve in Base Account/);
});

describe('the console never borrows the routers’ authority', () => {
  test('seven Quick examples demonstrate dispositions without claiming unreleased actions', () => {
    assert.equal(BASE_MCP_QUICK_EXAMPLES_V1.length, 7);
    assert.ok(BASE_MCP_CONSOLE_PROMPTS_V1.some((prompt) => /hold|transactions/i.test(prompt)));
    assert.ok(BASE_MCP_CONSOLE_PROMPTS_V1.some((prompt) => /send/i.test(prompt)));
    assert.ok(BASE_MCP_CONSOLE_PROMPTS_V1.some((prompt) => /swap/i.test(prompt)));
    assert.equal(BASE_MCP_CONSOLE_PROMPTS_V1.some((prompt) => /sign|launch/i.test(prompt)), false);
    assert.equal(
      BASE_MCP_CONSOLE_PROMPTS_V1.includes('Pay x402 GET https://api.venice.ai/api/v1/models, max 0.10 USDC'),
      false,
    );
    assert.ok(BASE_MCP_CONSOLE_PROMPTS_V1.includes('Show the models available from Venice AI'));
  });

  test('the global strip is labelled Quick examples and every shortcut only fills the console', () => {
    const selected: string[] = [];
    const html = renderToStaticMarkup(BaseMcpConsoleCard({
      question: '',
      onQuestionChange: (prompt) => selected.push(prompt),
      onAsk: () => assert.fail('rendering or selecting a Quick example must not execute'),
      pending: false,
      unavailableReason: null,
      answer: null,
    }));
    assert.match(html, /Quick examples/);
    assert.match(html, /routing demonstrations/);
    assert.match(html, /ROUTES AI/);
    assert.match(html, /PROVIDER UI/);
    assert.match(html, /ACTION/);
    assert.deepEqual(selected, []);
  });

  test('a disconnected Base App can explore and fill prompts but cannot Ask', () => {
    const html = renderToStaticMarkup(BaseMcpConsoleCard({
      question: 'Show the models available from Venice AI',
      onQuestionChange: () => undefined,
      onAsk: () => assert.fail('a disabled console must not execute'),
      pending: false,
      unavailableReason: null,
      answer: null,
      disabledReason: 'Connect your Base wallet to ask or run a plugin prompt.',
    }));
    assert.match(html, /Connect your Base wallet/);
    assert.match(html, /Ask Base MCP<\/button>/);
    assert.match(html, /<button type="button" class="btn" disabled=""/);
    assert.match(html, /Show the models available from Venice AI/);
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
    assert.equal(baseMcpConsoleStatusCopyV1(answer({ status: 'handoff' })), null);
    assert.equal(baseMcpConsoleStatusCopyV1(answer({ status: 'action' })), null);
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

// ---------------------------------------------------------------------------
// The header read `— READ · — ACTION` before the tool list was fetched: two
// machine words and two em-dashes standing in for numbers. The rail beside it
// was already saying the same counts in words a person uses, so the header was
// both the cryptic version AND the duplicate.
// ---------------------------------------------------------------------------
describe('the console header counts tools in words', () => {
  test('it says what a reader would say', () => {
    assert.equal(
      baseMcpToolSummaryV1({ readTools: 8, actionTools: 7 }),
      '8 readable · 7 require approval',
    );
    assert.equal(
      baseMcpToolSummaryV1({ readTools: 8, actionTools: 7, releasedActionTools: 3, routableTools: 1 }),
      '8 readable · 3 of 7 requiring approval are released · 1 hand off to Routes AI',
    );
  });

  test('an unread list is a sentence, not an em-dash', () => {
    assert.equal(baseMcpToolSummaryV1({}), 'tool list not read yet');
    // A dash where a number belongs reads as a count of nothing rather than as
    // an absence of counting.
    assert.doesNotMatch(baseMcpToolSummaryV1({}), /—/);
  });
});
