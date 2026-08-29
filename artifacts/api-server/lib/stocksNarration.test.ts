import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test, { describe } from 'node:test';

import { LlmProviderChainV1, OpenAiCompatibleClient } from '@mioagent/llm';
import type { LlmProvider, LlmRequest, LlmResponse } from '@mioagent/llm';

import {
  STOCKS_BENCH_ADDRESSES_V1,
  STOCKS_BENCH_CORPUS_V1,
  STOCKS_BENCH_NOW_V1,
  type StocksBenchCaseV1,
} from './stocksBenchCorpus.js';
import { stocksEvidenceBundleV1, type StocksEvidenceBundleV1 } from './stocksEvidence.js';
import {
  deterministicStocksNarrationV1,
  narrateStocksAnswerV1,
  parseStocksNarrationV1,
  verifyStocksNarrationV1,
  type StocksNarrationV1,
  type StocksNarrationViolationCodeV1,
} from './stocksNarration.js';

const { COINBASE_NVDA, BACKED_NVDA, BACKED_WRAPPER } = STOCKS_BENCH_ADDRESSES_V1;

function caseOf(id: StocksBenchCaseV1['id']): StocksBenchCaseV1 {
  const found = STOCKS_BENCH_CORPUS_V1.find((entry) => entry.id === id);
  assert.ok(found, `benchmark case ${id} is missing`);
  return found;
}

function bundleOf(id: StocksBenchCaseV1['id']): StocksEvidenceBundleV1 {
  const entry = caseOf(id);
  return stocksEvidenceBundleV1({
    question: entry.question,
    reality: entry.reality,
    history: entry.history,
    now: STOCKS_BENCH_NOW_V1,
  });
}

function itemId(bundle: StocksEvidenceBundleV1, kind: string, subject: string | null): string {
  const found = bundle.items.find(
    (item) => item.kind === kind && (subject === null ? item.subject === null : item.subject === subject),
  );
  assert.ok(found, `no ${kind} row for ${subject ?? 'the question'}`);
  return found.id;
}

/** A narration that passes, so a rejection test changes exactly one thing. */
function goodNarration(bundle: StocksEvidenceBundleV1): StocksNarrationV1 {
  return deterministicStocksNarrationV1(bundle);
}

function codes(verdict: { violations: Array<{ code: StocksNarrationViolationCodeV1 }> }): string[] {
  return verdict.violations.map((violation) => violation.code);
}

function verify(bundle: StocksEvidenceBundleV1, narration: StocksNarrationV1) {
  return verifyStocksNarrationV1({ raw: JSON.stringify(narration), bundle });
}

describe('the Stocks benchmark corpus', () => {
  test('carries every state the phase names, and every one of them is contract-valid', () => {
    assert.deepEqual(
      STOCKS_BENCH_CORPUS_V1.map((entry) => entry.id),
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
    );
    // Parsed through the shipped schemas at construction time, so this is a
    // statement about what production can produce, not about a hand-written
    // shape. Re-asserted here so a corpus that stops covering a state fails
    // rather than quietly narrowing the benchmark.
    const states = STOCKS_BENCH_CORPUS_V1.map((entry) => bundleOf(entry.id));
    assert.ok(states.some((bundle) => bundle.hasOpenEvidence), 'a fresh case');
    assert.ok(states.some((bundle) => !bundle.hasOpenEvidence), 'an expired case');
    assert.ok(states.some((bundle) => bundle.assertions.about === 'miorail'), 'a provider-failure case');
    assert.ok(states.some((bundle) => bundle.subjects.length >= 3), 'a multi-representation case');
    assert.ok(states.some((bundle) => bundle.missing.length === 0), 'a case with nothing withheld');
  });

  test('the deterministic answer is in the answer contract and passes every rule', () => {
    for (const entry of STOCKS_BENCH_CORPUS_V1) {
      const bundle = bundleOf(entry.id);
      const verdict = verify(bundle, deterministicStocksNarrationV1(bundle));
      assert.equal(verdict.ok, true, `${entry.id}: ${JSON.stringify(verdict.violations)}`);
    }
  });

  test('the bundle separates what is established from what is not', () => {
    // The Backed case has a price and no reference: both facts, on opposite
    // sides of the line, and the whole reason the answer contract has two
    // lists rather than one paragraph.
    const bundle = bundleOf('F');
    assert.ok(bundle.items.some((item) => item.kind === 'quote'));
    assert.ok(bundle.missing.some((entry) => entry.includes('reference price')));
    assert.ok(bundle.missing.some((entry) => entry.includes('basis is withheld')));
  });
});

describe('the Stocks verifier', () => {
  test('a reply that is not the answer contract is refused', () => {
    const bundle = bundleOf('A');
    for (const raw of ['', 'The Coinbase token costs 1000 USDC.', '{"subjects":[]}', '{']) {
      const verdict = verifyStocksNarrationV1({ raw, bundle });
      assert.equal(verdict.ok, false);
      assert.deepEqual(codes(verdict), ['not_the_answer_contract']);
    }
  });

  test('a code fence is stripped, not rejected', () => {
    const bundle = bundleOf('A');
    const raw = '```json\n' + JSON.stringify(goodNarration(bundle)) + '\n```';
    assert.equal(verifyStocksNarrationV1({ raw, bundle }).ok, true);
  });

  // --- 1. a number nobody measured -----------------------------------------
  test('a numeric value absent from the bundle is refused', () => {
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.explanation = 'The exact size returned 1234.56 USDC.';
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('unsupported_number'));
  });

  test('a number that is in the bundle but not in the row the claim cites is refused', () => {
    // The stricter half of the rule. A figure measured on ANOTHER row is in
    // the bundle, so the global check passes it; only the citation catches it.
    const bundle = bundleOf('J');
    const narration = goodNarration(bundle);
    // 178.4511 is Coinbase's effective price. The size in the question is
    // deliberately NOT used here: it is the frame every claim is about, so it
    // is ambient and citing it separately is not required.
    narration.established = [
      {
        claim: `${BACKED_NVDA} priced at 178.4511 USDC per token`,
        sourceIds: [itemId(bundle, 'route_status', BACKED_NVDA)],
      },
    ];
    narration.sources = narration.established.flatMap((entry) => entry.sourceIds);
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('claim_number_not_in_cited_evidence'));
  });

  // --- 2. invented issuer / reference / route -------------------------------
  test('an issuer that carries no representation here is refused', () => {
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.explanation = 'Dinari also issues this security.';
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('invented_issuer'));
  });

  test('a venue nobody asked is refused', () => {
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.explanation = 'Aerodrome offered the same price.';
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('invented_venue'));
  });

  test('a citation to a row that does not exist is refused', () => {
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.established = [{ claim: 'The reference feed was fresh.', sourceIds: ['e99'] }];
    narration.sources = ['e99'];
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('unknown_source_id'));
  });

  test('sources is repaired from the citations, not refused', () => {
    // It used to have to match exactly, and an otherwise perfect answer was
    // discarded for listing one id its claims did not cite. The claims carry
    // the citations; this field is their union, and a slip in a derived field
    // is not a false statement about a market.
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.sources = [...narration.sources, itemId(bundle, 'question', null)];
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
    assert.deepEqual(
      verdict.narration?.sources,
      narration.established.flatMap((entry) => entry.sourceIds),
      'the returned answer carries the citations, not what was declared',
    );
  });

  test('an unknown id in sources is still refused', () => {
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.sources = [...narration.sources, 'e404'];
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('unknown_source_id'));
  });

  test('an address that is not a reviewed representation cannot be a subject', () => {
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.subjects = ['0x00000000000000000000000000000000deadbeef'];
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('unknown_subject'));
  });

  // --- 3. judgements ---------------------------------------------------------
  test('judgements are refused, in both vocabularies', () => {
    const bundle = bundleOf('A');
    for (const sentence of [
      'This representation is liquid at the exact size.',
      'The Coinbase route is the best of the two.',
      'That is a bad price for the size.',
      'This token is safe to hold.',
      'The other one looks like a scam.',
      'Этот маршрут лучше остальных.',
    ]) {
      const narration = goodNarration(bundle);
      narration.explanation = sentence;
      const verdict = verify(bundle, narration);
      assert.equal(verdict.ok, false, sentence);
      assert.ok(
        codes(verdict).some((code) => code === 'judgement_vocabulary' || code === 'forbidden_vocabulary'),
        `${sentence}: ${codes(verdict).join(', ')}`,
      );
    }
  });

  // --- 4. one router is not the market ---------------------------------------
  test('a universal market claim drawn from one router is refused', () => {
    const bundle = bundleOf('C');
    for (const sentence of [
      'This token cannot be traded anywhere on Base.',
      'There is no liquidity for it.',
      'No market exists for this representation.',
      'Его нельзя продать нигде.',
    ]) {
      const narration = goodNarration(bundle);
      narration.explanation = sentence;
      const verdict = verify(bundle, narration);
      assert.equal(verdict.ok, false, sentence);
      assert.ok(codes(verdict).includes('universal_market_claim'), sentence);
    }
  });

  test('the product’s own coverage vocabulary is not a universal claim', () => {
    // "no market outcome is established" is the name of a coverage field and
    // the correct sentence. The first version of this rule matched it on the
    // substring "no market" and refused answers for saying the right thing.
    const bundle = bundleOf('C');
    const narration = goodNarration(bundle);
    narration.explanation =
      'No market outcome is established for this representation, and any router quote would be a price at one block.';
    const verdict = verify(bundle, narration);
    assert.equal(
      codes(verdict).includes('universal_market_claim'),
      false,
      JSON.stringify(verdict.violations),
    );
  });

  test('a caveat the bundle asked the narrator to preserve may be quoted', () => {
    // The bundle tells the narrator these sentences must survive any
    // paraphrase. A rule that then refuses the sentence it asked for is
    // refusing obedience: roughly a hundred benchmark rejections were exactly
    // this, on the fixtures the caveat exists for.
    const bundle = bundleOf('D');
    assert.equal(bundle.hasOpenEvidence, false);
    const caveat = bundle.caveats.find((entry) => entry.includes('current cost'));
    assert.ok(caveat, 'the no-open-evidence bundle carries that caveat');
    const narration = goodNarration(bundle);
    narration.explanation = caveat;
    const verdict = verify(bundle, narration);
    assert.equal(
      codes(verdict).includes('expired_quote_as_current'),
      false,
      JSON.stringify(verdict.violations),
    );
  });

  test('quoting a caveat does not license a present-tense price beside it', () => {
    const bundle = bundleOf('D');
    const caveat = bundle.caveats.find((entry) => entry.includes('current cost'))!;
    const narration = goodNarration(bundle);
    narration.explanation = `${caveat} It currently costs 1000 USDC to take that position.`;
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('expired_quote_as_current'));
  });

  test('the same absence stated about the reviewed router set is allowed', () => {
    // The rule is about the CLAIM, not about the sentiment: "no reviewed
    // router returned a route at this exact size" is the more negative
    // sentence and it is the true one.
    const bundle = bundleOf('C');
    const narration = goodNarration(bundle);
    // Deliberately phrased without "every venue": the rule refuses that
    // string even inside a denial, and over-rejection here costs a narration
    // that the deterministic answer already covers.
    narration.explanation =
      'No reviewed router returned a route at this exact size. Miorail asked one reviewed router set at one exact size.';
    assert.equal(verify(bundle, narration).ok, true);
  });

  // --- 5. our failure wearing the token's name -------------------------------
  test('a read that did not complete must be attributed', () => {
    const bundle = bundleOf('I');
    const narration = goodNarration(bundle);
    narration.established = narration.established.filter(
      (entry) => !entry.claim.toLowerCase().includes('miorail'),
    );
    narration.sources = narration.established.flatMap((entry) => entry.sourceIds);
    // The bundle's own absences name Miorail; these do not, which is the state
    // the rule exists to catch.
    narration.notEstablished = [...bundle.missing];
    narration.explanation = 'The measurement did not complete for this representation.';
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('provider_failure_unattributed'));
  });

  test('a failed read reported as a broken token is refused', () => {
    const bundle = bundleOf('I');
    const narration = goodNarration(bundle);
    narration.explanation = 'Miorail tried to read it. The token is broken.';
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('provider_failure_unattributed'));
  });

  // --- 6. an expired quote is history ----------------------------------------
  test('an expired quote described as current is refused', () => {
    const bundle = bundleOf('B');
    assert.equal(bundle.hasOpenEvidence, false);
    const narration = goodNarration(bundle);
    narration.explanation = 'It currently costs 1000 USDC to take that position.';
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('expired_quote_as_current'));
  });

  test('a bare "currently" with no figure is not a price claim', () => {
    // Found by the benchmark: the first version of this rule refused "there
    // is currently no outstanding supply", which is a true sentence about a
    // denominator and says nothing about a quote. The rule is about an
    // expired quote reported as a live cost, so it needs a cost in the
    // sentence.
    const bundle = bundleOf('E');
    assert.equal(bundle.hasOpenEvidence, false);
    const narration = goodNarration(bundle);
    narration.explanation = 'There is currently no outstanding supply at this address.';
    const verdict = verify(bundle, narration);
    assert.equal(
      codes(verdict).includes('expired_quote_as_current'),
      false,
      JSON.stringify(verdict.violations),
    );
  });

  test('the same figure with its age attached is allowed', () => {
    const bundle = bundleOf('B');
    const narration = goodNarration(bundle);
    narration.explanation =
      'The newest measurement is 48 minutes old and its evidence has expired, so it is history rather than a current cost.';
    assert.equal(verify(bundle, narration).ok, true);
  });

  // --- 7. zero supply is a denominator ---------------------------------------
  test('zero supply described as dead or delisted is refused', () => {
    const bundle = bundleOf('E');
    for (const sentence of [
      'This wrapper is dead.',
      'The token has been delisted.',
      'It is worthless now.',
      'Этот токен мертв.',
    ]) {
      const narration = goodNarration(bundle);
      narration.explanation = sentence;
      const verdict = verify(bundle, narration);
      assert.equal(verdict.ok, false, sentence);
      assert.ok(codes(verdict).includes('zero_supply_as_dead'), sentence);
    }
  });

  // --- 8. one representation may not borrow another's evidence ---------------
  test('Backed may not stand on Coinbase reference evidence', () => {
    const bundle = bundleOf('J');
    const narration = goodNarration(bundle);
    narration.established = [
      {
        claim: `${BACKED_NVDA} trades 12 bps against its reference`,
        sourceIds: [itemId(bundle, 'basis', COINBASE_NVDA)],
      },
    ];
    narration.sources = narration.established.flatMap((entry) => entry.sourceIds);
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('claim_cites_another_representation'));
  });

  test('a representation identity is a subject, never an established finding', () => {
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.established = [
      { claim: `${COINBASE_NVDA} is issued by coinbase`, sourceIds: [itemId(bundle, 'identity', COINBASE_NVDA)] },
    ];
    narration.sources = narration.established.flatMap((entry) => entry.sourceIds);
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('subject_as_established_claim'));
  });

  // --- absences ---------------------------------------------------------------
  test('an answer that states none of the bundle’s absences is refused', () => {
    const bundle = bundleOf('C');
    assert.ok(bundle.missing.length > 0);
    const narration = goodNarration(bundle);
    narration.notEstablished = [];
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('absences_not_stated'));
  });

  test('an invented absence is refused', () => {
    const bundle = bundleOf('A');
    assert.equal(bundle.missing.length, 0);
    const narration = goodNarration(bundle);
    narration.notEstablished = ['Miorail could not establish the outstanding supply.'];
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('absence_invented'));
  });

  test('the meaning of the deterministic answer must survive', () => {
    const bundle = bundleOf('A');
    const narration = goodNarration(bundle);
    narration.explanation = 'Nothing was measured for this security.';
    const verdict = verify(bundle, narration);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('meaning_changed'));
  });

  // --- the support map --------------------------------------------------------
  test('the verifier names the evidence row behind each material statement', () => {
    const bundle = bundleOf('A');
    const verdict = verify(bundle, goodNarration(bundle));
    assert.equal(verdict.ok, true);
    assert.ok(verdict.support.length > 0);
    for (const entry of verdict.support) {
      assert.ok(entry.items.length > 0, `"${entry.claim}" has no supporting row`);
      for (const item of entry.items) {
        assert.ok(bundle.items.some((row) => row.id === item.id));
      }
    }
    const quoteClaim = verdict.support.find((entry) => entry.items.some((item) => item.kind === 'quote'));
    assert.ok(quoteClaim, 'the priced case supports at least one claim from a quote row');
  });
});

// ---------------------------------------------------------------------------
// The reasoning-model failure, end to end.
//
// Measured against deepseek-v4-flash on 2026-08-25: content empty,
// reasoning_content full, finish_reason "length". The client turns that into a
// thrown error rather than an empty reply; this proves the chain then falls
// over, and that the reasoning text never reaches the answer.
// ---------------------------------------------------------------------------

describe('a reasoning model that answered with nothing', () => {
  const reasoningFailure = () =>
    new Error('Model deepseek-v4-flash returned no content after 1222 characters of reasoning (finish_reason: length)');

  test('is a provider failure, and the chain falls over', async () => {
    const bundle = bundleOf('A');
    const calls: string[] = [];
    const chain = new LlmProviderChainV1([
      {
        label: 'primary',
        provider: {
          async generate(): Promise<LlmResponse> {
            calls.push('primary');
            throw reasoningFailure();
          },
        },
      },
      {
        label: 'spare',
        provider: {
          async generate(): Promise<LlmResponse> {
            calls.push('spare');
            return {
              message: { role: 'assistant', content: JSON.stringify(goodNarration(bundle)) },
            };
          },
        },
      },
    ]);

    const answered = await narrateStocksAnswerV1({ bundle, provider: chain });
    assert.deepEqual(calls, ['primary', 'spare']);
    assert.equal(answered.answerSource, 'verified_narration');
  });

  test('falls back to the deterministic answer when no spare is configured', async () => {
    const bundle = bundleOf('A');
    const provider: LlmProvider = {
      async generate(): Promise<LlmResponse> {
        throw reasoningFailure();
      },
    };
    const answered = await narrateStocksAnswerV1({ bundle, provider });
    assert.equal(answered.answerSource, 'deterministic_evidence');
    assert.match(answered.providerError ?? '', /no content after 1222 characters of reasoning/);
    assert.deepEqual(answered.answer, deterministicStocksNarrationV1(bundle));
  });

  test('reasoning text is never the answer', async () => {
    // The shape that must not pass: a provider that returns the working as if
    // it were the reply. It is not the answer contract, so it is refused.
    const bundle = bundleOf('A');
    const provider: LlmProvider = {
      async generate(): Promise<LlmResponse> {
        return {
          message: {
            role: 'assistant',
            content: 'Let me think. The user asks about NVDA. I should check the quote row...',
          },
        };
      },
    };
    const answered = await narrateStocksAnswerV1({ bundle, provider });
    assert.equal(answered.answerSource, 'deterministic_evidence');
    assert.deepEqual(
      (answered.rejectedBecause ?? []).map((violation) => violation.code),
      ['not_the_answer_contract'],
    );
  });
});

// ---------------------------------------------------------------------------
// The permission boundary (phase §6).
//
// Not a prompt rule. The narrator is handed two messages and nothing else:
// no tools array, no functions, no wallet, no read it could take on its own.
// A model that decided to prepare a transaction here would have nothing to
// decide it WITH, which is the only version of this guarantee worth stating.
// ---------------------------------------------------------------------------

describe('the Stocks narrator has no actions', () => {
  test('the provider is handed messages and a temperature, and no capability', async () => {
    const bundle = bundleOf('A');
    let seen: LlmRequest | null = null;
    const provider: LlmProvider = {
      async generate(request: LlmRequest): Promise<LlmResponse> {
        seen = request;
        return { message: { role: 'assistant', content: JSON.stringify(goodNarration(bundle)) } };
      },
    };
    await narrateStocksAnswerV1({ bundle, provider });
    const request = seen as unknown as LlmRequest;
    assert.ok(request, 'the provider was called');
    assert.deepEqual(Object.keys(request).sort(), ['messages', 'temperature']);
    assert.equal(request.tools, undefined);
    assert.equal(request.messages.length, 2);
    assert.deepEqual(
      request.messages.map((message) => message.role),
      ['system', 'user'],
    );
    for (const message of request.messages) {
      assert.equal(message.tool_calls, undefined);
      assert.equal(message.tool_call_id, undefined);
    }
  });

  test('a tool call in the reply is not an action, it is a non-answer', async () => {
    const bundle = bundleOf('A');
    const provider: LlmProvider = {
      async generate(): Promise<LlmResponse> {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'wallet_sendCalls', arguments: '{}' } },
            ],
          },
        };
      },
    };
    const answered = await narrateStocksAnswerV1({ bundle, provider });
    assert.equal(answered.answerSource, 'deterministic_evidence');
    // The tool call is discarded with the rest of the reply. Nothing in this
    // pipeline can dispatch one: there is no executor between the provider and
    // the verifier.
    assert.equal(JSON.stringify(answered.answer).includes('wallet_sendCalls'), false);
  });

  test('the request that reaches the wire carries no tool, function or capability', async () => {
    // One level below the provider interface: the narrator is run through the
    // real HTTP client, and the body it puts on the wire is inspected. A
    // permission that is absent from the request cannot be granted by a prompt,
    // and cannot be re-granted by a caller who forgets this rule.
    const bundle = bundleOf('A');
    let body: Record<string, unknown> | null = null;
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://provider.invalid',
      apiKey: 'test-key-not-a-credential',
      defaultModel: 'bench-model',
      fetchImpl: (async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: JSON.stringify(goodNarration(bundle)) } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    const answered = await narrateStocksAnswerV1({ bundle, provider: client });
    assert.equal(answered.answerSource, 'verified_narration');
    const sent = body as unknown as Record<string, unknown>;
    assert.ok(sent, 'a request was sent');
    assert.deepEqual(Object.keys(sent).sort(), ['messages', 'model', 'temperature']);
    for (const forbidden of ['tools', 'tool_choice', 'functions', 'function_call']) {
      assert.equal(forbidden in sent, false, `the body carries ${forbidden}`);
    }
  });

  test('the runtime cannot reach an execution module, because it does not import one', () => {
    // The strongest form of the boundary available without a sandbox: walk the
    // import closure of the narrator and the bundle builder and see what is in
    // it. A capability the runtime never links cannot be granted by a prompt,
    // a tool description, or a caller who forgets the rule — there is no code
    // path to it at all.
    // Resolved from the working directory rather than import.meta: this
    // package builds to CommonJS, where import.meta is not available.
    const here = [
      resolve(process.cwd(), 'artifacts/api-server/lib'),
      resolve(process.cwd(), 'lib'),
    ].find((candidate) => existsSync(resolve(candidate, 'stocksNarration.ts')));
    assert.ok(here, 'the narrator source is where the test expects it');
    const closure = new Set<string>();
    const packages = new Set<string>();
    const walk = (file: string): void => {
      if (closure.has(file)) return;
      closure.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) {
          if (specifier.startsWith('@mioagent/')) packages.add(specifier);
          continue;
        }
        const base = resolve(dirname(file), specifier.replace(/\.js$/, ''));
        for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
          if (existsSync(candidate)) {
            walk(candidate);
            break;
          }
        }
      }
    };
    walk(resolve(here, 'stocksNarration.ts'));
    walk(resolve(here, 'stocksEvidence.ts'));

    assert.deepEqual(
      [...closure].map((file) => file.slice(here.length + 1)).sort(),
      ['b20AnswerVerify.ts', 'stocksEvidence.ts', 'stocksNarration.ts'],
      'the Stocks narrator runtime is three files',
    );
    assert.deepEqual(
      [...packages].sort(),
      ['@mioagent/llm', '@mioagent/rwa-market-reality/contracts'],
      'a provider interface and a set of contracts — no wallet, no chain, no repository',
    );
    // And nothing in those three files names an action.
    const sources = [...closure].map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const forbidden of [
      'wallet_sendCalls',
      'signTransaction',
      'encodeFunctionData',
      'sendTransaction',
      'privateKey',
      'blueprint',
      'useSubmitApproved',
      'eth_sendRawTransaction',
    ]) {
      assert.equal(
        sources.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `the narrator runtime names ${forbidden}`,
      );
    }
  });

  test('the evidence bundle carries no wallet, key or execution field', () => {
    for (const entry of STOCKS_BENCH_CORPUS_V1) {
      const serialised = JSON.stringify(bundleOf(entry.id));
      for (const forbidden of [
        'privateKey',
        'signer',
        'wallet_sendCalls',
        'calldata',
        'blueprintId',
        'permissionHash',
        'walletAddress',
        'Bearer ',
        'api_key',
        'apiKey',
      ]) {
        assert.equal(serialised.includes(forbidden), false, `${entry.id} carries ${forbidden}`);
      }
    }
  });
});

describe('parsing', () => {
  test('a partial object is not half an answer', () => {
    assert.equal(parseStocksNarrationV1('{"subjects":["0x1"],"established":[]}'), null);
  });

  test('an unknown key is refused rather than dropped', () => {
    const bundle = bundleOf('A');
    const narration = { ...goodNarration(bundle), transaction: { to: COINBASE_NVDA } };
    assert.equal(parseStocksNarrationV1(JSON.stringify(narration)), null);
  });

  test('the wrapper address is a distinct subject from the token it wraps', () => {
    const bundle = bundleOf('J');
    assert.ok(bundle.subjects.some((subject) => subject.tokenAddress === BACKED_WRAPPER));
    assert.ok(bundle.subjects.some((subject) => subject.tokenAddress === BACKED_NVDA));
    assert.notEqual(BACKED_WRAPPER, BACKED_NVDA);
  });
});
