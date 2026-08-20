import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_CONSOLE_MAX_TOKENS_V1,
  b20AddressesInV1,
  planB20ConsoleAnswerV1,
} from './b20ConsolePlan.js';

// ---------------------------------------------------------------------------
// The global console's planner.
//
// Two properties are worth more than the routing itself: a step can only ever
// be one of four bounded reads, and the only argument that comes from the
// reader is an address they typed. Everything else is a constant in the
// planner, so the set of things a question can cause is fixed and small.
// ---------------------------------------------------------------------------

const plan = (
  question: string,
  scope: 'explore' | 'investigate' | 'changes' = 'explore',
  tokenAddresses?: string[],
) => planB20ConsoleAnswerV1({ question, scope, tokenAddresses });

const TOKEN_A = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';

describe('an address comes from the reader, never from a symbol', () => {
  test('addresses are extracted, lowercased and deduplicated', () => {
    assert.deepEqual(b20AddressesInV1(`Compare ${TOKEN_A} with ${TOKEN_B} and ${TOKEN_A}`), [
      TOKEN_A,
      TOKEN_B,
    ]);
  });

  test('a checksummed address from a block explorer is the same address', () => {
    // The case that actually arrives: EIP-55 upper-cases letters in the BODY.
    const checksummed = '0xAbC0000000000000000000000000000000000dEf';
    assert.deepEqual(b20AddressesInV1(`look at ${checksummed}`), [checksummed.toLowerCase()]);
  });

  test('an upper-cased prefix is still an address', () => {
    // Somebody who upper-cased what they pasted has still named a token.
    assert.deepEqual(b20AddressesInV1(TOKEN_A.toUpperCase()), [TOKEN_A]);
  });

  test('a symbol is not an address', () => {
    // Several Base tokens answer to any given symbol, so resolving one would be
    // Miorail choosing a token and then measuring its own choice.
    assert.deepEqual(b20AddressesInV1('what about WORM and PEPE'), []);
    assert.equal(plan('what about WORM', 'investigate').refusal !== null, true);
  });

  test('a short hex string is not an address', () => {
    assert.deepEqual(b20AddressesInV1('0xdeadbeef'), []);
  });
});

describe('scope decides which reads may run', () => {
  test('explore defaults to the counts', () => {
    const result = plan('what does the universe look like');
    assert.equal(result.scope, 'explore');
    assert.deepEqual(
      result.steps.map((step) => step.tool),
      ['summary'],
    );
  });

  test('changes reads the movers rail', () => {
    const result = plan('anything at all', 'changes');
    assert.deepEqual(
      result.steps.map((step) => step.tool),
      ['changes'],
    );
  });

  test('investigate with no token refuses, and says what it needs', () => {
    const result = plan('tell me about it', 'investigate');
    assert.equal(result.steps.length, 0);
    assert.match(result.refusal ?? '', /Paste one or more Base token addresses/);
  });

  test('investigate reads exactly the tokens it was given', () => {
    const result = plan('compare these', 'investigate', [TOKEN_A, TOKEN_B]);
    assert.deepEqual(result.tokenAddresses, [TOKEN_A, TOKEN_B]);
    const step = result.steps[0];
    assert.equal(step?.tool, 'cards');
  });

  test('the token list is capped', () => {
    const many = Array.from({ length: 9 }, (_value, index) => `0x${String(index).repeat(40)}`);
    const result = plan('compare', 'investigate', many);
    assert.equal(result.tokenAddresses.length, B20_CONSOLE_MAX_TOKENS_V1);
  });
});

describe('the question can move the scope, and the plan says so', () => {
  test('an address in an Explore question answers about the token', () => {
    // Somebody who pastes an address wants that token, whichever tab is open.
    const result = plan(`what about ${TOKEN_A}`, 'explore');
    assert.equal(result.scope, 'investigate');
    assert.deepEqual(result.tokenAddresses, [TOKEN_A]);
  });

  test('a question about movement is answered by the movers read', () => {
    // The counts cannot see time. Answering "what changed" with a snapshot
    // would be answering a different question.
    const result = plan('what changed since yesterday', 'explore');
    assert.equal(result.scope, 'changes');
    assert.deepEqual(
      result.steps.map((step) => step.tool),
      ['changes'],
    );
  });

  test('a Russian question about movement moves too', () => {
    const result = plan('что изменилось за сутки', 'explore');
    assert.equal(result.scope, 'changes');
  });

  test('an explicit Changes tab is never overridden by an unrecognised question', () => {
    assert.equal(plan('покажи всё', 'changes').scope, 'changes');
  });
});

describe('out of scope is refused in every scope, before any read', () => {
  for (const scope of ['explore', 'investigate', 'changes'] as const) {
    test(`price prediction in ${scope}`, () => {
      const result = plan('will this moon', scope);
      assert.equal(result.steps.length, 0);
      assert.equal(result.intent, 'unsupported');
      assert.match(result.refusal ?? '', /does not measure price/);
    });

    test(`scam labelling in ${scope}`, () => {
      const result = plan(`is ${TOKEN_A} a scam`, scope);
      assert.equal(result.steps.length, 0);
      assert.match(result.refusal ?? '', /does not label tokens as scams/);
    });
  }

  test('a refusal reads nothing even with a token in hand', () => {
    // The address is present and valid; the question is still not one this
    // product answers, and refusing after a read would spend a metered call to
    // say so.
    const result = plan(`should I buy ${TOKEN_A}`, 'investigate', [TOKEN_A]);
    assert.deepEqual(result.steps, []);
    assert.deepEqual(result.tokenAddresses, []);
  });
});

describe('the universe intents survive from the card planner', () => {
  test('bought but not sellable, in English', () => {
    const result = plan('which tokens did people buy but cannot sell');
    assert.equal(result.intent, 'find_bought_not_sellable');
    assert.deepEqual(
      result.steps.map((step) => step.tool),
      ['summary', 'list'],
    );
  });

  test('bought but not sellable, in Russian word order', () => {
    // Russian puts the negation after the verb, so an ordered regex written
    // from the English phrasing matches nothing at all.
    assert.equal(plan('Какие токены купили, а продать нельзя?').intent, 'find_bought_not_sellable');
  });

  test('coverage questions ask for the launches Miorail did not search', () => {
    const result = plan('where has coverage been incomplete');
    assert.equal(result.intent, 'find_not_searched');
    const list = result.steps.find((step) => step.tool === 'list');
    assert.equal(list?.tool === 'list' ? list.standingKind : null, 'venue_not_searched');
  });
});

describe('no step can carry an argument the planner did not choose', () => {
  const questions = [
    'how many launches are there',
    'what changed',
    'which ones priced both routes',
    `look at ${TOKEN_A}`,
    'покажи покрытие',
  ];

  for (const question of questions) {
    test(`"${question}"`, () => {
      for (const step of plan(question).steps) {
        assert.ok(['summary', 'list', 'cards', 'changes'].includes(step.tool));
        if (step.tool === 'cards') {
          // The only reader-supplied value in any plan, and it is an address
          // that matched a strict pattern.
          for (const address of step.tokenAddresses) assert.match(address, /^0x[0-9a-f]{40}$/);
        }
        if (step.tool === 'list') assert.ok(step.limit > 0 && step.limit <= 10);
        if (step.tool === 'summary') assert.equal(step.launchAgeHours, 48);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The four fundamental questions the console has to answer.
//
// Three of them are about ONE token and are answered by the card read that
// already exists — the card now carries its project profile, so no new step is
// needed and none was added. The fourth is about the corpus, and it is the only
// one that needed a plan of its own.
// ---------------------------------------------------------------------------
describe('project questions', () => {
  /** The predicate a question planned to, or null when it planned to something
   * else entirely. */
  function predicateFor(question: string): string | null {
    const plan = planB20ConsoleAnswerV1({ question, scope: 'explore' });
    const step = plan.steps.find((entry) => entry.tool === 'projects');
    return step?.tool === 'projects' ? step.predicate : null;
  }

  function projectStepFor(question: string) {
    const planned = planB20ConsoleAnswerV1({ question, scope: 'explore' });
    return planned.steps.find((entry) => entry.tool === 'projects');
  }

  test('"which launches are connected to verified projects" reads the claimed ones', () => {
    const plan = planB20ConsoleAnswerV1({
      question: 'Which B20 launches are connected to verified projects?',
      scope: 'explore',
    });
    assert.equal(plan.intent, 'find_verified_projects');
    assert.equal(
      predicateFor('Which B20 launches are connected to verified projects?'),
      'verified_project',
    );
  });

  test('the same question in Russian reaches the same plan', () => {
    // `\b` is ASCII-only, so a Cyrillic pattern carries no word boundary — the
    // reason an earlier Russian matcher died silently.
    const plan = planB20ConsoleAnswerV1({
      question: 'у каких токенов есть проверенный проект?',
      scope: 'explore',
    });
    assert.equal(plan.intent, 'find_verified_projects');
  });

  // Every predicate, in both languages the console is asked in. Written as one
  // table because the failure that matters is a question reaching the WRONG
  // predicate, and that is only visible when they are compared side by side.
  const PREDICATE_QUESTIONS: readonly [string, readonly string[]][] = [
    [
      'live_product',
      [
        'Show B20 launches with a live product',
        'Which B20 are connected to a working product?',
        'Покажи B20 с реально работающим продуктом',
        'какие B20 связаны с работающим продуктом?',
      ],
    ],
    [
      'verified_website',
      [
        'Which B20 have a verified website?',
        'show me launches whose site is verified',
        'Какие B20 имеют проверенный сайт?',
        'у каких токенов есть сайт?',
      ],
    ],
    [
      'repository_found',
      [
        'Which B20 projects have a repository?',
        'show me the ones with github',
        'у каких B20 есть репозиторий?',
        'покажи проекты с открытым кодом',
      ],
    ],
    ['docs_found', ['Which B20 projects have documentation?', 'какие проекты имеют документацию?']],
    [
      'development_active',
      [
        'Which B20 projects are under active development?',
        'which ones are still being built?',
        'у каких проектов активная разработка?',
        'где разработка идёт до сих пор?',
      ],
    ],
    [
      'project_before_token',
      [
        'Which B20 projects existed before their token?',
        'show launches whose project predates the launch',
        'какие проекты существовали до запуска токена?',
        'кто старше токена?',
      ],
    ],
    [
      'verified_base_presence',
      [
        'Which B20 projects have a verified Base presence?',
        'у каких проектов есть присутствие на base?',
      ],
    ],
  ];

  for (const [predicate, questions] of PREDICATE_QUESTIONS) {
    test(`${predicate} is reached from EN and RU`, () => {
      for (const question of questions) {
        assert.equal(predicateFor(question), predicate, question);
      }
    });
  }

  test('a fundamental question reads the claimed corpus and NOTHING else', () => {
    // The bug this replaces: the plan ran a 48-hour universe summary first, so
    // every project answer opened with how many launches were measured — a
    // number about a different corpus, printed as though it were the
    // denominator.
    for (const question of [
      'Show B20 launches with a live product',
      'Покажи B20 с работающим продуктом',
    ]) {
      const plan = planB20ConsoleAnswerV1({ question, scope: 'explore' });
      assert.equal(plan.steps.length, 1, question);
      assert.equal(plan.steps[0]?.tool, 'projects', question);
      assert.ok(
        !plan.steps.some((step) => step.tool === 'summary' || step.tool === 'list'),
        `${question} still reads the measurement universe`,
      );
    }
  });

  test('positive fundamental predicates compose with OR and AND', () => {
    const union = projectStepFor('Which B20 tokens have a verified website or Base presence?');
    assert.deepEqual(union?.tool === 'projects' ? union.predicates : null, [
      'verified_website',
      'verified_base_presence',
    ]);
    assert.equal(union?.tool === 'projects' ? union.operator : null, 'or');

    const intersection = projectStepFor(
      'Which B20 tokens have a live product and verified website?',
    );
    assert.deepEqual(intersection?.tool === 'projects' ? intersection.predicates : null, [
      'live_product',
      'verified_website',
    ]);
    assert.equal(intersection?.tool === 'projects' ? intersection.operator : null, 'and');
  });

  test('a question for the ABSENCE of a fundamental is refused, not answered', () => {
    // Miorail probes only what a project declared, so it can show a product
    // answered and can never show a project has none. Answering these from the
    // same rows as their positive twin would publish "not checked" as "nothing
    // there" for every launch outside the corpus.
    for (const question of [
      'Which B20 have no product?',
      'show me launches without a website',
      'which projects are missing documentation?',
      'какие B20 без продукта?',
      'у каких проектов нет сайта?',
      'покажи токены, у которых нет репозитория',
    ]) {
      const plan = planB20ConsoleAnswerV1({ question, scope: 'explore' });
      assert.equal(plan.intent, 'unsupported', question);
      assert.deepEqual(plan.steps, [], question);
      assert.match(plan.refusal ?? '', /cannot answer which projects lack something/i);
      assert.match(plan.refusal ?? '', /unknown/i);
    }
  });

  test('a question about ONE token stays an investigate read, and needs no new step', () => {
    // "Does MIO have a live product?" and "did this project exist before its
    // token launch?" are both answered from the card, which carries the
    // profile. An address in the question moves the scope, as it always has.
    for (const question of [
      'Does 0xb200000000000000000000578f3ae29d9e6e0101 have a live product?',
      'Did 0xb200000000000000000000578f3ae29d9e6e0101 exist before its token launch?',
      'What fundamental evidence is missing for 0xb200000000000000000000578f3ae29d9e6e0101?',
    ]) {
      const plan = planB20ConsoleAnswerV1({ question, scope: 'explore' });
      assert.equal(plan.scope, 'investigate', question);
      assert.equal(plan.steps[0]?.tool, 'cards', question);
      assert.deepEqual(plan.tokenAddresses, ['0xb200000000000000000000578f3ae29d9e6e0101']);
    }
  });

  test('a question about project quality is not a question this planner answers', () => {
    // "Which project is good" has no plan, and must not be quietly answered by
    // the verified-project read — a list of verified links is not a ranking.
    const plan = planB20ConsoleAnswerV1({
      question: 'Which B20 project is the best investment?',
      scope: 'explore',
    });
    assert.notEqual(plan.intent, 'find_verified_projects');
  });
});

// ---------------------------------------------------------------------------
// The production prompts.
//
// Every line below was typed into the live console in Base App on 2026-08-19,
// and most of them went to the wrong read. They are pinned here as sentences a
// person actually wrote, not as phrasings chosen to fit a pattern — which was
// the original defect: the matcher recognised Miorail's own vocabulary ("both
// directions", "round trip") and almost nothing a reader would say.
// ---------------------------------------------------------------------------

describe('a reader may ask in their own words', () => {
  test('a "bought but no sale" question in any of its natural phrasings', () => {
    // The first of these came back as the universe counts in production: the
    // old pattern required the sale word AFTER the negation, and English puts
    // it before as often as not.
    for (const question of [
      'Which B20 tokens were bought but a sale could not be priced?',
      "entry worked but exit didn't",
      "could buy but couldn't sell",
      "buy route exists but sale doesn't",
      'Which tokens did people buy and then not manage to sell?',
      'Какие токены купили, а продать не смогли?',
      'Какие токены купили, а продать нельзя?',
    ]) {
      const result = plan(question);
      assert.equal(result.intent, 'find_bought_not_sellable', question);
      assert.deepEqual(
        result.steps.map((step) => step.tool),
        ['summary', 'list'],
        question,
      );
    }
  });

  test('a "both directions" question without Miorail’s own words for it', () => {
    for (const question of [
      'Show B20 tokens where both entry and exit were priced',
      'which ones can be bought and sold',
      'Which B20 priced in both directions?',
      'Какие токены можно и купить и продать?',
    ]) {
      const result = plan(question);
      assert.equal(result.intent, 'find_two_sided', question);
    }
  });

  test('a negation keeps a two-legged question out of the two-sided read', () => {
    // The one thing that separates the two: "bought and could not be sold"
    // carries an entry word, an exit word and a join word, exactly like the
    // question above it.
    assert.equal(
      plan('tokens that were bought and could not be sold').intent,
      'find_bought_not_sellable',
    );
  });

  test('"which launches need more evidence, and why" has its own read', () => {
    for (const question of [
      'Which B20 launches need more evidence, and why?',
      'Where is the measurement incomplete?',
      'Какие запуски требуют больше доказательств?',
    ]) {
      const result = plan(question);
      assert.equal(result.intent, 'find_needs_evidence', question);
      const list = result.steps.find((step) => step.tool === 'list');
      assert.ok(list && list.tool === 'list' && list.standing === 'miorail_limit', question);
    }
  });

  test('"what is worth looking at" is answered, not refused', () => {
    // It used to be refused from Investigate, which read as the console being
    // unable to understand a plain English sentence.
    for (const [question, scope] of [
      ['Find me the most interesting B20 tokens to investigate', 'investigate'],
      ['What should I look at?', 'explore'],
      ['Самые интересные токены', 'investigate'],
    ] as const) {
      const result = plan(question, scope);
      assert.equal(result.intent, 'find_research_candidates', question);
      assert.equal(result.refusal, null, question);
      // Answered in Explore, and the plan SAYS so, so the panel can relabel
      // itself instead of putting a universe answer under an Investigate tab.
      assert.equal(result.scope, 'explore', question);
      assert.deepEqual(
        result.steps.map((step) => step.tool),
        ['research'],
        question,
      );
    }
  });

  test('an address anywhere in the sentence still wins', () => {
    for (const question of [
      `Check ${TOKEN_A}`,
      `Investigate ${TOKEN_A}`,
      `What do we know about ${TOKEN_A}?`,
      `Does this B20 token have a working market? ${TOKEN_A}`,
    ]) {
      const result = plan(question, 'explore');
      assert.equal(result.scope, 'investigate', question);
      assert.equal(result.intent, 'compare_tokens', question);
      assert.deepEqual(result.tokenAddresses, [TOKEN_A], question);
    }
  });

  test('Investigate still refuses a question that really is about unnamed tokens', () => {
    // The refusal is right here and stays. What changed is that it no longer
    // catches every sentence typed under this tab.
    for (const question of ['What was measured here?', 'How do these compare?']) {
      const result = plan(question, 'investigate');
      assert.equal(result.intent, 'unsupported', question);
      assert.equal(result.scope, 'investigate', question);
      // And it points somewhere, rather than only saying no.
      assert.match(result.refusal ?? '', /Explore/);
    }
  });

  test('a universe question asked from Investigate is answered in Explore', () => {
    const result = plan('How many launches were measured?', 'investigate');
    assert.equal(result.scope, 'explore');
    assert.equal(result.intent, 'universe_counts');
  });
});
