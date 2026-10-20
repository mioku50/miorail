import { createHash } from 'node:crypto';
import { logger } from '@mioagent/utils';
import type { EvidenceToolV1 } from '../routes/mcp/evidencePackage.js';

/** Only successful evidence reads reach here. No arguments, answer, address,
 * URL, credential, raw IP or raw User-Agent is recorded. Fingerprints measure
 * client groups, not verified people; known internal clients are excluded by
 * the weekly report. Logging is best effort in the shared registry. */
export function evidenceReadUsageV1(input: {
  surface: 'public' | 'connected'; actorKey: string; userAgent: string;
}) {
  const userAgent = input.userAgent.slice(0, 300);
  const clientFamily = /brickbluebot/i.test(userAgent) ? 'brickbluebot'
    : /taifoon/i.test(userAgent) ? 'taifoon'
      : /b20.*verif|verif.*b20|miorail/i.test(userAgent) ? 'internal'
        : /curl\//i.test(userAgent) ? 'curl' : 'unclassified';
  const actorFingerprint = createHash('sha256').update(`miorail-evidence-usage/v1|${input.surface}|${input.actorKey}`).digest('hex');
  const clientFingerprint = createHash('sha256').update(`${actorFingerprint}|${userAgent}`).digest('hex');
  return (toolName: EvidenceToolV1) => logger.info('MCP evidence read', {
    usageVersion: 1, toolName, surface: input.surface, clientFamily, actorFingerprint, clientFingerprint,
  });
}
