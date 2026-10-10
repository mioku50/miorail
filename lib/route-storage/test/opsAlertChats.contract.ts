import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { OpsAlertChatRepositoryV1 } from '../src/opsAlertChats.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 12, minute));

/** What both stores of service-alert chats must do: the in-memory one is
 * held to the tables' refusals, and the tables to the same behaviour. */
export function opsAlertChatContractV1(label: string, open: () => Promise<OpsAlertChatRepositoryV1>) {
  describe(`service alert chats (${label})`, () => {
    test('a code subscribes the chat that brings it, once, and only before it expires', async () => {
      const chats = await open();
      await chats.issueCode({ codeHash: HASH_A, now: at(0), expiresAt: at(10) });
      assert.deepEqual(await chats.redeemCode({ codeHash: HASH_A, chatId: '42', now: at(1) }), { subscribedNow: true });
      assert.equal(await chats.redeemCode({ codeHash: HASH_A, chatId: '43', now: at(2) }), null);
      assert.deepEqual(await chats.chats(), ['42']);

      await chats.issueCode({ codeHash: HASH_B, now: at(0), expiresAt: at(10) });
      assert.equal(await chats.redeemCode({ codeHash: HASH_B, chatId: '43', now: at(10) }), null);
      assert.equal(await chats.isSubscribed('43'), false);
    });

    test('a chat subscribed twice is listed once; /stop removes it', async () => {
      const chats = await open();
      await chats.issueCode({ codeHash: HASH_A, now: at(0), expiresAt: at(10) });
      await chats.issueCode({ codeHash: HASH_B, now: at(0), expiresAt: at(10) });
      await chats.redeemCode({ codeHash: HASH_A, chatId: '42', now: at(1) });
      assert.deepEqual(await chats.redeemCode({ codeHash: HASH_B, chatId: '42', now: at(2) }), { subscribedNow: false });
      assert.deepEqual(await chats.chats(), ['42']);
      assert.equal(await chats.unsubscribe('42'), true);
      assert.equal(await chats.unsubscribe('42'), false);
      assert.deepEqual(await chats.chats(), []);
    });

    test('what the tables refuse is refused here too', async () => {
      const chats = await open();
      await assert.rejects(chats.issueCode({ codeHash: 'not-a-hash', now: at(0), expiresAt: at(10) }));
      await assert.rejects(chats.issueCode({ codeHash: HASH_A, now: at(10), expiresAt: at(10) }));
      await chats.issueCode({ codeHash: HASH_A, now: at(0), expiresAt: at(10) });
      await assert.rejects(chats.issueCode({ codeHash: HASH_A, now: at(0), expiresAt: at(10) }));
      await assert.rejects(chats.redeemCode({ codeHash: HASH_A, chatId: '-100123', now: at(1) }));
      assert.equal(await chats.redeemCode({ codeHash: 'short', chatId: '42', now: at(1) }), null);
      assert.equal(await chats.pruneCodes({ before: at(11) }), 1);
    });
  });
}
