import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

// The deploy applies this journal with drizzle's migrator, which skips every
// entry whose `when` is not later than the last one production recorded. Nine
// migrations were once applied by hand and never journaled, and two files
// shared the number 0070. A file outside the journal is a migration no fresh
// database runs; an entry out of order is one a deploy silently skips.
test('every migration file is journaled once, in order, under its own number', async () => {
  const journal = JSON.parse(await readFile(resolve(drizzleDir(), 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  const files = (await readdir(drizzleDir())).filter((name) => name.endsWith('.sql')).map((name) => name.slice(0, -4));
  const tags = journal.entries.map((entry) => entry.tag);
  assert.deepEqual([...tags].sort(), [...files].sort(), 'journal tags and .sql files differ');
  assert.equal(new Set(tags).size, tags.length, 'a tag is journaled twice');
  const numbers = tags.map((tag) => tag.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, 'two migrations share a number');
  journal.entries.forEach((entry, index) => {
    assert.equal(entry.idx, index, `${entry.tag} is out of index order`);
    if (index > 0) {
      assert.ok(entry.when > journal.entries[index - 1]!.when, `${entry.tag} is not later than the entry before it`);
    }
  });
});

test('a new migration journals after the last one production recorded', async () => {
  // 0078's `when` (2026-09-09) is the last row drizzle wrote in production;
  // 0069-0077 sit below it because they were applied by hand. Anything newer
  // must come after it, or the deploy skips it without a word.
  const journal = JSON.parse(await readFile(resolve(drizzleDir(), 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ when: number; tag: string }>;
  };
  const watermark = journal.entries.findIndex((entry) => entry.tag === '0078_coinbase_stocks_api');
  assert.ok(watermark >= 0);
  assert.equal(journal.entries[watermark]!.when, 1788960600000);
  for (const entry of journal.entries.slice(watermark + 1)) {
    assert.ok(entry.when > 1788960600000, entry.tag);
  }
});
