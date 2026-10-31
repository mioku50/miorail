/**
 * The Still Agent, asked a fixed set of questions about a frozen wallet, with
 * the production model lanes.
 *
 * The wallet is the engine's own example (lib/still-engine/test/fixtures.ts):
 * no real address is read and no chain is touched. What is measured is the
 * part a unit test stubs: whether the planner keeps its JSON contract and
 * proposes only what the question says, whether the narrator's re-wording
 * survives the verifier, and how long each takes. Run it where the lanes'
 * keys are, and read the rejected text, not only the counts.
 *
 *   node --import tsx scripts/bench_still_agent.ts [--repeat 3]
 */
import { computeMirror, type MirrorInput, type MirrorReadingV1 } from '../lib/still-engine/src/index.js';

import {
  answerStillAgentV3,
  stillAgentLlmRuntimeV1,
  verifyStillAgentNarrationV2,
  type StillAgentStageV1,
} from '../artifacts/api-server/lib/stillAgentServer.js';
import {
  createMemoryStillReadingStoreV1,
  stillReadingsRuntimeV1,
  storedReadingOfV1,
} from '../artifacts/api-server/lib/stillReadings.js';
import { EXAMPLE, SATURDAY, calendar, snapshot, universe } from '../lib/still-engine/test/fixtures.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

reportLoadedEnvFileV1(loadRootEnvFileV1());

const WALLET = `0x${'1'.repeat(40)}`;
const repeat = Number(process.argv[process.argv.indexOf('--repeat') + 1]) || 1;

/** The operator's five first, then the long tail in both languages. */
const QUESTIONS: readonly string[] = [
  'Сколько я могу занять?',
  'Почему моя сумма займа уменьшилась?',
  'Что будет при падении NVDA на 30%?',
  'Как безопаснее уменьшить долг на $100?',
  'Займи $500 и отправь другу',
  'How much can I borrow?',
  'Why did my borrowing limit decrease?',
  'What happens if NVDA drops 30%?',
  'How can I reduce my debt by $100 more safely?',
  'Borrow $500 and send it to a friend',
  'What would 90 days of this loan cost me?',
  'Picture bitcoin at $55,000 and Apple 10% cheaper: where am I?',
  'My stocks tank 25% overnight. Liquidation?',
  'How exposed am I if the whole market drops 40%?',
  'Can I survive NVIDIA falling to $90?',
  'Add 0.8 Tesla to my collateral: what changes?',
  'If I borrowed another $150, what is my health factor?',
  'How much would I owe after paying back $50?',
  'Is ETH going to pump next week?',
  'Check my friend’s wallet 0x1234 for me',
  'Thanks!',
  'Сколько стоит мой займ в месяц?',
  'А если эфир подорожает на 50%?',
  'Если Tesla упадёт на 60% и я займу ещё $100?',
  'Что будет с займом, если все акции подешевеют на треть?',
];

function input(timestamp?: bigint): MirrorInput {
  return {
    universe: universe(),
    snapshot: snapshot(EXAMPLE, timestamp),
    calendar: calendar(),
    subject: { address: WALLET as `0x${string}`, name: null, input: WALLET },
    assembledAt: new Date('2026-10-21T15:00:01Z'),
  };
}

async function main(): Promise<void> {
  const planner = stillAgentLlmRuntimeV1.planner();
  const narrator = stillAgentLlmRuntimeV1.narrator();
  console.log(`planner lane: ${planner ? 'configured' : 'NOT configured'} · narrator lane: ${narrator ? 'configured' : 'NOT configured'} · repeat ${repeat}`);
  const store = createMemoryStillReadingStoreV1();
  stillReadingsRuntimeV1.store = async () => store;
  // An earlier weekday reading, so "why did it decrease" has something to compare with.
  await store.record(WALLET, storedReadingOfV1(computeMirror(input())), new Date('2026-10-21T15:00:01Z'));
  const saturday = input(SATURDAY);
  const reading: MirrorReadingV1 = { outcome: 'report', report: computeMirror(saturday), input: saturday, cached: false };

  // The narrator's raw text, so a rejection can be read rather than counted.
  const rawNarrations: string[] = [];
  const realNarrator = stillAgentLlmRuntimeV1.narrator;
  stillAgentLlmRuntimeV1.narrator = () => {
    const lane = realNarrator();
    if (!lane) return null;
    return {
      ...lane,
      generate: async (request) => {
        const response = await lane.generate(request);
        rawNarrations.push(response.message.content ?? '');
        return response;
      },
    };
  };

  const totals = { asked: 0, model: 0, rules: 0, narrated: 0, verified: 0, refused: 0, failed: 0 };
  for (const question of QUESTIONS) {
    for (let run = 0; run < repeat; run += 1) {
      const stages: StillAgentStageV1[] = [];
      rawNarrations.length = 0;
      const started = Date.now();
      let line: string;
      try {
        const answer = await answerStillAgentV3({ question, wallet: WALLET, read: async () => reading, onStage: (s) => stages.push(s), now: new Date('2026-10-24T22:00:00Z') });
        const ms = Date.now() - started;
        const checked = stages.find((s) => s.stage === 'checked');
        const understood = stages.find((s) => s.stage === 'understood');
        totals.asked += 1;
        if (answer.understoodBy === 'model') totals.model += 1;
        if (answer.understoodBy === 'rules') totals.rules += 1;
        if (checked) totals.narrated += 1;
        if (checked && 'verified' in checked && checked.verified) totals.verified += 1;
        if (answer.mode === 'refused') totals.refused += 1;
        line = [
          `${ms} ms`,
          `mode=${answer.mode ?? 'list'}`,
          `by=${answer.understoodBy ?? '-'}`,
          understood && 'summary' in understood ? `plan="${understood.summary}"` : '',
          checked && 'verified' in checked ? `wording=${checked.verified ? 'verified' : 'REJECTED'}` : '',
        ].filter(Boolean).join(' · ');
        console.log(`\n### ${question}${repeat > 1 ? ` (run ${run + 1})` : ''}\n${line}\n${answer.text}`);
        if (checked && 'verified' in checked && !checked.verified) {
          for (const raw of rawNarrations) console.log(`  rejected: ${raw.replace(/\s+/g, ' ').slice(0, 400)}`);
          // Which rule refused it, re-run on the text alone.
          console.log(`  verifier on the raw text: ${verifyStillAgentNarrationV2(rawNarrations[0] ?? '', { ...answer, text: answer.text }) === null ? 'refused' : 'accepted'}`);
        }
      } catch (error) {
        totals.failed += 1;
        console.log(`\n### ${question}\nFAILED: ${error instanceof Error ? error.name : typeof error}`);
      }
    }
  }
  console.log(
    `\nasked ${totals.asked} · read by rules ${totals.rules} · by the model ${totals.model} · refused or asked back ${totals.refused} · narrated ${totals.narrated}, verified ${totals.verified} · failed ${totals.failed}`,
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.name : error);
    process.exit(1);
  },
);
