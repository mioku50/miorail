import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_UNSUPPORTED_QUESTIONS_V1,
  b20UniverseIntentV1,
  b20UnsupportedRefusalV1,
  questionIsRussianV1,
} from './b20AnswerPlan.js';

// ---------------------------------------------------------------------------
// A refusal is answered in the language it was earned in.
//
// The patterns were bilingual from the start — every rule carries a Cyrillic
// alternative — so a Russian «стоит ли покупать?» was correctly identified as
// out of scope and then declined in English. On a console whose whole point is
// that Russian is first-class, that reads as a surface which did not
// understand rather than one which declined.
// ---------------------------------------------------------------------------

describe('B20 scope refusals', () => {
  test('every rule carries both languages', () => {
    for (const rule of B20_UNSUPPORTED_QUESTIONS_V1) {
      assert.ok(rule.refusal.trim().length > 0);
      assert.ok(rule.refusalRu.trim().length > 0);
      assert.ok(questionIsRussianV1(rule.refusalRu), 'the Russian refusal is written in Russian');
      assert.equal(questionIsRussianV1(rule.refusal), false, 'the English one is not');
    }
  });

  test('a Russian question is refused in Russian, an English one in English', () => {
    const cases: readonly [string, boolean][] = [
      ['Стоит ли покупать NVDA?', true],
      ['Дай прогноз цены NVDA', true],
      ['Это скам?', true],
      ['Кто владелец этого токена?', true],
      ['Should I buy NVDA?', false],
      ['Give me a price forecast', false],
      ['Is this a scam?', false],
    ];
    for (const [question, russian] of cases) {
      const refusal = b20UnsupportedRefusalV1(question);
      assert.ok(refusal, `"${question}" must be refused`);
      assert.equal(questionIsRussianV1(refusal), russian, question);
    }
  });

  test('a question inside scope earns no refusal in either language', () => {
    assert.equal(b20UnsupportedRefusalV1('Сколько токенов измерено?'), null);
    assert.equal(b20UnsupportedRefusalV1('How many tokens were measured?'), null);
  });

  test('one Cyrillic letter is enough to pick the language', () => {
    assert.equal(questionIsRussianV1('Should I buy NVDA?'), false);
    assert.equal(questionIsRussianV1('Стоит ли брать NVDA prediction?'), true);
  });
});

// ---------------------------------------------------------------------------
// The two "priced" intents must not be describable in the same words.
//
// «Какие запуски купили, но не могут продать?» classified as find_two_sided
// three times out of three on prod, while the same question with "токены" in
// place of "запуски" classified correctly. Both definitions named entry and
// exit and neither made the NEGATION the distinguishing fact, so the reader
// got a well-formed, verified answer to a question they had not asked — which
// is worse than a refusal.
// ---------------------------------------------------------------------------

test('the classifier prompt makes the two priced intents mutually exclusive', async () => {
  const { B20_CONSOLE_INTENT_SYSTEM_PROMPT_V1 } = await import('./b20ConsoleIntent.js');
  const bought = /- find_bought_not_sellable: ([^\n]+)/.exec(B20_CONSOLE_INTENT_SYSTEM_PROMPT_V1)?.[1] ?? '';
  const twoSided = /- find_two_sided: ([^\n]+)/.exec(B20_CONSOLE_INTENT_SYSTEM_PROMPT_V1)?.[1] ?? '';
  assert.ok(bought.length > 0 && twoSided.length > 0, 'both intents are defined');
  assert.match(bought, /did NOT|cannot sell|cannot exit/, 'the failing side is stated as the deciding fact');
  assert.match(twoSided, /BOTH/, 'the succeeding side is stated as both');
  assert.match(twoSided, /Never choose this when/, 'and it names the case it must not take');
});

// ---------------------------------------------------------------------------
// A missing negation form sends a question to the opposite intent.
//
// The bought-not-sellable matcher REQUIRES a negation and the two-sided one is
// disqualified by it, so the two live or die on the same vocabulary. On prod
// «Какие запуски купили, но НЕ МОГУТ продать?» resolved to find_two_sided
// three runs out of three, while «…но продать НЕ СМОГЛИ?» — one verb over,
// and `не смог` was in the list — resolved correctly. The reader was given a
// well-formed, verified answer to the opposite question.
// ---------------------------------------------------------------------------

describe('the two priced intents share one negation vocabulary', () => {
  test('a Russian question about a failed sale is never two-sided', () => {
    const failed = [
      'какие запуски купили, но не могут продать?',
      'какие токены купили, но не может продать никто?',
      'купили, а продать не смогли',
      'вошли, но выйти нельзя',
      'покупка прошла, продажа невозможна',
      'зашли и не выйдут',
    ];
    for (const question of failed) {
      assert.equal(b20UniverseIntentV1(question).intent, 'find_bought_not_sellable', question);
    }
  });

  test('a question about both sides pricing stays two-sided', () => {
    for (const question of [
      'which b20 tokens priced both entry and exit?',
      'какие токены оценили и вход, и выход?',
      'round trip priced',
    ]) {
      assert.equal(b20UniverseIntentV1(question).intent, 'find_two_sided', question);
    }
  });

  test('the English side keeps working', () => {
    assert.equal(
      b20UniverseIntentV1('which b20 tokens were bought but cannot sell?').intent,
      'find_bought_not_sellable',
    );
  });
});
