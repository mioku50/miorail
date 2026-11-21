import { createHash, createHmac, randomBytes } from 'node:crypto';
import { deriveKey } from '@mioagent/crypto';
import { logger } from '@mioagent/utils';
import type { EvidenceToolV1 } from '../routes/mcp/evidencePackage.js';

/** Only successful evidence reads reach here. No arguments, answer, address,
 * URL, credential, raw IP or raw User-Agent is recorded. Fingerprints measure
 * client groups, not verified people; known internal clients are excluded by
 * the weekly report. Logging is best effort in the shared registry. */
// An unsalted SHA-256 of an IP is reversed by trying all of IPv4 in minutes (audit 11-20 PRIV-4). So the actor is
// keyed with the server's own secret, which the log never holds; with none (a test), a key for this process alone.
let fingerprintKeyV1: Buffer | null = null;
const fingerprintKey = (): Buffer => {
  if (!fingerprintKeyV1) {
    const secret = process.env.SESSION_SECRET?.trim();
    fingerprintKeyV1 = secret ? deriveKey(secret, 'miorail-evidence-usage/v2') : randomBytes(32);
  }
  return fingerprintKeyV1;
};

export function evidenceReadUsageV1(input: {
  surface: 'public' | 'connected'; actorKey: string; userAgent: string;
}) {
  const userAgent = input.userAgent.slice(0, 300);
  const clientFamily = /brickbluebot/i.test(userAgent) ? 'brickbluebot'
    : /taifoon/i.test(userAgent) ? 'taifoon'
      : /b20.*verif|verif.*b20|miorail/i.test(userAgent) ? 'internal'
        : /curl\//i.test(userAgent) ? 'curl' : 'unclassified';
  const actorFingerprint = createHmac('sha256', fingerprintKey()).update(`${input.surface}|${input.actorKey}`).digest('hex');
  const clientFingerprint = createHash('sha256').update(`${actorFingerprint}|${userAgent}`).digest('hex');
  return (toolName: EvidenceToolV1) => logger.info('MCP evidence read', {
    usageVersion: 2, toolName, surface: input.surface, clientFamily, actorFingerprint, clientFingerprint,
  });
}
