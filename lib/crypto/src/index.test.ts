import { test } from 'node:test';
import assert from 'node:assert';
import { deriveKey, encrypt, decrypt, createHmac } from './index.js';

test('deriveKey derives a consistent 32-byte key', () => {
  const secret = 'super-secret-session-key';
  const salt = 'some-random-salt';

  const key1 = deriveKey(secret, salt);
  const key2 = deriveKey(secret, salt);

  assert.strictEqual(key1.length, 32);
  assert.strictEqual(key2.length, 32);
  assert.ok(key1.equals(key2), 'Derived keys with same inputs should be identical');
});

test('encrypt and decrypt work correctly', () => {
  const secret = 'my-secret';
  const salt = 'salt123';
  const key = deriveKey(secret, salt);
  const plaintext = 'hello world! this is a secret message.';

  const encrypted = encrypt(plaintext, key);
  assert.notStrictEqual(encrypted, plaintext, 'Encrypted text should not match plaintext');

  const parts = encrypted.split(':');
  assert.strictEqual(
    parts.length,
    3,
    'Encrypted string should have 3 parts (iv:authTag:ciphertext)',
  );

  const decrypted = decrypt(encrypted, key);
  assert.strictEqual(decrypted, plaintext, 'Decrypted text should match original plaintext');
});

test('decrypt fails with wrong key', () => {
  const key1 = deriveKey('secret1', 'salt');
  const key2 = deriveKey('secret2', 'salt');
  const plaintext = 'secret message';

  const encrypted = encrypt(plaintext, key1);

  assert.throws(() => {
    decrypt(encrypted, key2);
  }, /Unsupported state or unable to authenticate data|Decipher final failed/);
});

test('createHmac generates consistent HMAC', () => {
  const secret = 'hmac-secret';
  const text = 'data to sign';

  const hmac1 = createHmac(text, secret);
  const hmac2 = createHmac(text, secret);

  assert.strictEqual(hmac1, hmac2, 'HMACs with same inputs should be identical');
  assert.ok(hmac1.length > 0, 'HMAC should not be empty');
});
