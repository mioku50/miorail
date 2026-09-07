import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BASE_MCP_PROVIDER_INTENTS_V1,
  exampleCapabilityStateV1,
} from '@mioagent/security';

import { baseMcpRuntimeSnapshotV1 } from './baseMcpRuntimeSnapshot.js';
import { moonwellAssetV1, printrQuoteInputV1 } from './baseMcpReadInputs.js';

/**
 * An example prompt is a CLAIM about what happens when it is clicked.
 *
 * The button fills the console with that exact text, so a prompt the handler
 * must refuse on arrival is a promise the surface breaks by itself — twice
 * already: GMGN advertised a per-token report its API does not have, and
 * Printr advertised a Base+Arbitrum cost while the handler parsed nothing from
 * it and came back asking for two numbers the prompt never mentioned.
 *
 * The rule is not "every prompt must run" — several reads are ABOUT an address
 * the reader supplies, and that is fine as long as the prompt SHOWS the gap it
 * expects them to fill. So: a released read either parses in its own handler,
 * or names its missing input where the reader can see it.
 */
// `\b` after an ellipsis matches nothing — `…` is not a word character — so the
// alternatives that end in one carry no trailing boundary. The first draft did,
// and rejected the very prompt it was written to accept.
const PLACEHOLDER_V1 = /\bthis\b|\bthese\b|0x…|0x\.\.\.|<[a-z ]+>/i;

/** The parsers a reviewed read runs before it calls anybody. */
const PARSERS_V1: Readonly<Record<string, (message: string) => unknown>> = {
  'printr:cost': printrQuoteInputV1,
  'moonwell:markets': moonwellAssetV1,
  'printr:status': (message) =>
    ([...new Set(message.match(/\b0x[a-fA-F0-9]{1,128}\b/g) ?? [])].length === 1 ? true : null),
  'bankr:inspect': (message) => message.match(/0x[a-fA-F0-9]{40}/u)?.[0] ?? null,
  'opensea:listing': (message) => message.match(/0x[a-fA-F0-9]{40}/u)?.[0] ?? null,
};

describe('an example prompt is servable by the handler it points at', () => {
  const runtime = baseMcpRuntimeSnapshotV1();

  test('a released read either parses, or shows the reader what to fill in', () => {
    const broken: string[] = [];
    for (const plugin of BASE_MCP_PROVIDER_INTENTS_V1) {
      for (const example of plugin.examples) {
        if (example.disposition !== 'read_in_extensions') continue;
        if (exampleCapabilityStateV1(plugin, example, runtime).state !== 'released') continue;
        const parser = PARSERS_V1[`${plugin.pluginId}:${example.id}`];
        if (!parser) continue;
        const parsed = parser(example.prompt);
        const servable = parsed !== null && parsed !== undefined;
        if (!servable && !PLACEHOLDER_V1.test(example.prompt)) {
          broken.push(`${plugin.pluginId}:${example.id} — "${example.prompt}"`);
        }
      }
    }
    assert.deepEqual(
      broken,
      [],
      `these prompts are refused by their own handler and do not say what is missing:\n${broken.join('\n')}`,
    );
  });

  test('the Printr cost prompt carries every input its quote needs', () => {
    // The regression in full: chains alone parsed to null, so the click spent a
    // round trip to be told about an initial buy and a graduation target that
    // the prompt had never mentioned.
    const example = BASE_MCP_PROVIDER_INTENTS_V1
      .find((plugin) => plugin.pluginId === 'printr')!
      .examples.find((entry) => entry.id === 'cost')!;
    const parsed = printrQuoteInputV1(example.prompt) as {
      chains: string[];
      graduation_threshold_per_chain_usd: number;
    } | null;
    assert.ok(parsed, 'the Printr cost prompt must parse into a quote request');
    // And the chains it names are the chains the handler sends — the exact
    // mismatch that made "Base and Arbitrum" arrive as Base.
    assert.deepEqual(parsed.chains, ['eip155:8453', 'eip155:42161']);
    assert.ok(parsed.graduation_threshold_per_chain_usd >= 15_000);
  });

  test('a read that needs an address the reader owns says so in the prompt', () => {
    for (const [key, id] of [['bankr', 'inspect'], ['opensea', 'listing'], ['printr', 'status']] as const) {
      const example = BASE_MCP_PROVIDER_INTENTS_V1
        .find((plugin) => plugin.pluginId === key)!
        .examples.find((entry) => entry.id === id)!;
      assert.match(example.prompt, PLACEHOLDER_V1, `${key}:${id} must show the gap it expects filled`);
    }
  });
});
