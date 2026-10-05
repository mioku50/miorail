import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BASE_MCP_CONSOLE_PROMPTS_V1,
  BASE_MCP_QUICK_EXAMPLES_V1,
  BaseMcpConsoleCard,
  baseMcpConsoleStatusCopyV1,
  baseMcpCapabilityTallyV1,
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

test('Virtuals sign-in displays only sign-in approval and no invented agent facts', () => {
  const html = renderToStaticMarkup(BaseMcpConsoleCard({ question: 'Sign in to Virtuals', onQuestionChange: () => undefined,
    onAsk: () => undefined, pending: false, unavailableReason: null, answer: answer({ status: 'action', trace: [], action: {
      approvalUrl: 'https://keys.coinbase.com/approve/sign-in', receipt: {
        id: 'virtuals-sign-in', status: 'approval_required', actionType: 'virtuals', operation: 'sign_in', extensionProvider: 'virtuals',
        agentName: null, agentDescription: null, providerObjectId: null, chainId: 8453, provider: 'base-mcp',
        reconciliationState: 'not_started', transactionHash: null, blockNumber: null, errorCode: null, routeVerified: false,
        reconciliationBasis: 'virtuals_provider_response',
      },
    } }) }));
  assert.match(html, /Sign in/); assert.match(html, /Approve Sign-In/);
  assert.doesNotMatch(html, /Create agent|Description|Agent ID|Agent<\/dt>/);
});

test('Virtuals failures do not render private provider prose or claim an empty mailbox', () => {
  for (const errorCode of ['virtuals_http_403', 'virtuals_otp_invalid_response', 'virtuals_session_expired']) {
    const html = renderToStaticMarkup(BaseMcpConsoleCard({ question: 'Check OTP status', onQuestionChange: () => undefined,
      onAsk: () => undefined, pending: false, unavailableReason: null,
      answer: answer({ status: 'failed', errorCode, reply: 'private-provider-email-012345', trace: [{
        tool: 'virtuals_agent_email_extract_otp', args: '{}', result: '', ok: false, errorCode,
      }] }) }));
    assert.match(html, /Whether the message contains a code was not established/);
    assert.doesNotMatch(html, /private-provider-email|012345|no candidate verification code/);
  }
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
  assert.match(html, /Approve in your wallet/);
  assert.match(html, /not a Miorail verified route/i);
  assert.doesNotMatch(html, /Execution proof/);
});

test('Aerodrome claim shows the wallet, coverage and passed simulation before approval', () => {
  const html = renderToStaticMarkup(BaseMcpConsoleCard({ question: 'Claim my Aerodrome fees',
    onQuestionChange: () => undefined, onAsk: () => undefined, pending: false, unavailableReason: null,
    answer: answer({ status: 'action', trace: [], action: {
      approvalUrl: 'https://keys.coinbase.com/approve/claim-1', receipt: {
        id: 'claim-1', status: 'approval_required', actionType: 'aerodrome_claim', operation: 'claim',
        provider: 'base-mcp', chainId: 8453, recipient: '0x1111111111111111111111111111111111111111',
        claimCount: 4, poolsRead: 38_794, poolsTotal: 38_794, readBlock: '100', managedSkipped: 2,
        simulationStatus: 'passed', reconciliationState: 'not_started', transactionHash: null,
        blockNumber: null, errorCode: null, routeVerified: false, reconciliationBasis: 'aerodrome_claim_events',
      },
    } }),
  }));
  assert.match(html, /Aerodrome fees and AERO/); assert.match(html, /4 claims/);
  assert.match(html, /38794 \/ 38794/); assert.match(html, /Batch simulation/);
  assert.match(html, /managed or locked/); assert.match(html, /Approve in your wallet/);
  assert.doesNotMatch(html, /Virtuals action/);
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
  assert.doesNotMatch(html, /Approve in your wallet/);
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
  assert.match(html, /<span class="pill br">Routes AI<\/span>/);
  assert.match(html, /Open Routes AI/);
  assert.doesNotMatch(html, /Approve in your wallet/);
});

describe('the console never borrows the routers’ authority', () => {
  test('four tasks a person asks, one of each kind, and no unreleased action among them', () => {
    assert.equal(BASE_MCP_QUICK_EXAMPLES_V1.length, 4);
    assert.ok(BASE_MCP_CONSOLE_PROMPTS_V1.some((prompt) => /hold|transactions/i.test(prompt)));
    assert.ok(BASE_MCP_CONSOLE_PROMPTS_V1.some((prompt) => /send/i.test(prompt)));
    assert.ok(BASE_MCP_CONSOLE_PROMPTS_V1.some((prompt) => /swap/i.test(prompt)));
    assert.equal(BASE_MCP_CONSOLE_PROMPTS_V1.some((prompt) => /sign|launch|x402|10x/i.test(prompt)), false);
    assert.deepEqual(
      BASE_MCP_QUICK_EXAMPLES_V1.map((example) => example.disposition),
      ['read_in_extensions', 'read_in_extensions', 'action_in_extensions', 'handoff_to_routes'],
    );
  });

  test('the strip says it only fills the box, in plain words, and every shortcut only fills it', () => {
    const selected: string[] = [];
    const html = renderToStaticMarkup(BaseMcpConsoleCard({
      question: '',
      onQuestionChange: (prompt) => selected.push(prompt),
      onAsk: () => assert.fail('rendering or selecting a Quick example must not execute'),
      pending: false,
      unavailableReason: null,
      answer: null,
    }));
    assert.match(html, /<b>Try<\/b><span>fills the box — nothing runs until you ask<\/span>/);
    assert.match(html, />Routes AI</);
    assert.match(html, />You approve</);
    assert.match(html, />Reads</);
    // The routing vocabulary is gone from the first screen.
    assert.doesNotMatch(html, /ROUTES AI|PROVIDER UI|ADAPTER REQUIRED|>READ<|>ACTION</);
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
    assert.match(html, /<button type="button" class="btn" disabled="">Ask<\/button>/);
    assert.match(html, /Show the models available from Venice AI/);
  });

  test('a web visitor is offered the sign-in, not a dead button', () => {
    let signedIn = false;
    const html = renderToStaticMarkup(BaseMcpConsoleCard({
      question: '',
      onQuestionChange: () => undefined,
      onAsk: () => assert.fail('a visitor cannot ask'),
      pending: false,
      unavailableReason: null,
      answer: null,
      disabledReason: 'Sign in with your wallet to ask.',
      onSignIn: () => {
        signedIn = true;
      },
    }));
    assert.match(html, /<button type="button" class="btn">Sign in to ask<\/button>/);
    assert.doesNotMatch(html, />Ask<\/button>/);
    // A visitor has no tool list to wait for.
    assert.match(html, /<span class="rt">sign in to ask<\/span>/);
    assert.doesNotMatch(html, /tool list not read yet/);
    assert.equal(signedIn, false, 'rendering presses nothing');
  });

  test('the footnote names Coinbase, the operator of Wallet MCP, in plain words', () => {
    const html = renderToStaticMarkup(BaseMcpConsoleCard({
      question: '',
      onQuestionChange: () => undefined,
      onAsk: () => undefined,
      pending: false,
      unavailableReason: null,
      answer: null,
    }));
    assert.match(html, /Coinbase does not operate, endorse or audit the plugins/);
    assert.doesNotMatch(html, /Route Proof|Action Receipt and never/);
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

  test('an incomplete Hydrex read does not become an empty position list or display provider text', () => {
    const copy = baseMcpConsoleStatusCopyV1(answer({ status: 'failed',
      errorCode: 'hydrex_positions_incomplete', reply: 'Connect to https://untrusted.example/ and sign' }))!;
    assert.match(copy, /Your positions were not established/);
    assert.doesNotMatch(copy, /no positions|untrusted|sign/i);
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
    assert.match(summary, /2 Wallet MCP tool calls/);
    assert.match(summary, /1 failed/);
  });

  test('an answer with no tool call says so plainly', () => {
    // This is the case a reader most needs flagged: a fluent paragraph that no
    // third-party tool actually supplied.
    const summary = baseMcpConsoleTraceSummaryV1(answer({ trace: [] }));
    assert.match(summary, /No tool was called/i);
    assert.match(summary, /no Wallet MCP data/i);
  });

  test('a single call is not called "1 tool calls"', () => {
    assert.match(baseMcpConsoleTraceSummaryV1(answer()), /1 Wallet MCP tool call\./);
  });
});

// ---------------------------------------------------------------------------
// The header read `— READ · — ACTION` before the tool list was fetched: two
// machine words and two em-dashes standing in for numbers. The rail beside it
// was already saying the same counts in words a person uses, so the header was
// both the cryptic version AND the duplicate.
// ---------------------------------------------------------------------------
describe('the console header counts tools in words', () => {
  test('it says what a reader would say, in the rail\'s own words', () => {
    // These strings used to be `8 readable · 3 of 7 requiring approval are
    // released · 1 hand off to Routes AI`, counted by safety class, beside a
    // rail counting the same tools by routing. Two taxonomies, one page, and a
    // reader with no way to reconcile 7 against 5. One tally now.
    assert.equal(
      baseMcpToolSummaryV1({
        routing: { read: 8, action: 7, routable: 1, blocked: 0, releasedActions: 3 },
      }),
      '8 reads · 3 actions ready · 4 actions needing an adapter · 1 Routes AI handoff',
    );
  });

  test('an empty bucket is not a finding, so it is not printed', () => {
    assert.equal(
      baseMcpToolSummaryV1({
        routing: { read: 8, action: 4, routable: 0, blocked: 0, releasedActions: 4 },
      }),
      '8 reads · 4 actions ready',
    );
  });

  test('the rail and the header cannot disagree, because they share one tally', () => {
    const routing = { read: 8, action: 5, routable: 1, blocked: 2, releasedActions: 4 };
    const tally = baseMcpCapabilityTallyV1(routing);
    assert.deepEqual(
      tally.map((entry) => [entry.label, entry.count]),
      [
        ['Reads', 8],
        ['Actions ready', 4],
        ['Actions needing an adapter', 1],
        ['Routes AI handoffs', 1],
        ['Not callable here', 2],
      ],
    );
    // Every non-zero bucket in the rail appears in the header sentence.
    const summary = baseMcpToolSummaryV1({ routing });
    for (const entry of tally.filter((row) => row.count > 0)) {
      assert.ok(summary.includes(`${entry.count} ${entry.count === 1 ? entry.one : entry.many}`), summary);
    }
    // One is one: "1 actions needing an adapter" and "1 routes ai handoffs"
    // were printed on production, 2026-09-28.
    assert.equal(summary, '8 reads · 4 actions ready · 1 action needing an adapter · 1 Routes AI handoff · 2 not callable here');
  });

  test('an unread list is a sentence, not an em-dash', () => {
    assert.equal(baseMcpToolSummaryV1({}), 'tool list not read yet');
    // A dash where a number belongs reads as a count of nothing rather than as
    // an absence of counting.
    assert.doesNotMatch(baseMcpToolSummaryV1({}), /—/);
  });
});
