import * as crypto from 'node:crypto';

/**
 * Derives a key using HKDF.
 * @param secret The input keying material.
 * @param salt The salt value.
 * @param length The length of the derived key in bytes. Defaults to 32 (256 bits).
 * @param info Optional context/application specific info.
 * @returns The derived key buffer.
 */
export function deriveKey(secret: string, salt: string, length = 32, info = ''): Buffer {
  // node:crypto hkdfSync returns an ArrayBuffer
  const arrayBuf = crypto.hkdfSync('sha256', secret, salt, info, length);
  return Buffer.from(arrayBuf);
}

/**
 * Encrypts a string using AES-256-GCM.
 * @param text The text to encrypt.
 * @param secret The 32-byte encryption key (hex or base64 encoded, or raw buffer as string if length matches, usually should derive using HKDF first). For simplicity we assume it's a 32-byte key derived.
 * @returns The encrypted string encoded as base64 (iv:authTag:ciphertext).
 */
export function encrypt(text: string, secretKeyBuffer: Buffer): string {
  if (secretKeyBuffer.length !== 32) {
    throw new Error('Secret key must be 32 bytes for AES-256-GCM.');
  }

  const iv = crypto.randomBytes(12); // 96-bit IV is recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKeyBuffer, iv);

  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypts a string encrypted with AES-256-GCM using the `encrypt` function.
 * @param encryptedText The encrypted text (iv:authTag:ciphertext).
 * @param secret The 32-byte decryption key.
 * @returns The decrypted string.
 */
export function decrypt(encryptedText: string, secretKeyBuffer: Buffer): string {
  if (secretKeyBuffer.length !== 32) {
    throw new Error('Secret key must be 32 bytes for AES-256-GCM.');
  }

  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format.');
  }

  const [ivBase64, authTagBase64, ciphertext] = parts;
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKeyBuffer, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Creates an HMAC for a given text and secret.
 * @param text The text to hash.
 * @param secret The secret key.
 * @returns The HMAC hex string.
 */
export function createHmac(text: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}
