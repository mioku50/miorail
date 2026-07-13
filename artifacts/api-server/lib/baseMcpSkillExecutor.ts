// T48b: BaseMcpSkillExecutor — loads a named, official Base MCP HTTP plugin
// (Uniswap, Moonwell) ONLY when the user explicitly named the protocol
// (reuses the existing intent/namespace detection in
// @mioagent/runtime-skills — detectRuntimeSkill/getRuntimeSkill), reads the
// plugin's structured manifest, and hands routing code a small execution
// plan: a `request()` method that can only reach the endpoints listed in the
// manifest's allowlist.pathPrefixes. Every actual HTTP call goes through the
// constrained `pluginHttpRequest` gateway (pluginHttpGateway.ts), so the same
// host/method/path/chain/credential guarantees apply here. This module is
// called only by deterministic server routing, never registered as an LLM
// tool.

import { detectRuntimeSkill, getRuntimeSkill, type RuntimeSkillDefinition, type RuntimeSkillManifest } from '@mioagent/runtime-skills';
import { pluginHttpRequest, type PluginHttpResponse } from './pluginHttpGateway.js';

export class SkillPathNotAllowedError extends Error {
  readonly plugin: string;
  readonly path: string;
  constructor(plugin: string, path: string) {
    super(`Skill executor: path is not in the ${plugin} manifest allowlist: ${path}`);
    this.name = 'SkillPathNotAllowedError';
    this.plugin = plugin;
    this.path = path;
  }
}

export interface BaseMcpSkillExecutor {
  namespace: string;
  manifest: RuntimeSkillManifest;
  /** Ordered list of endpoint paths this execution plan may call — the manifest allowlist. */
  allowedPaths: string[];
  request(input: { path: string; method: 'GET' | 'POST'; body?: unknown; chainId?: number }): Promise<PluginHttpResponse>;
}

function buildExecutor(skill: RuntimeSkillDefinition): BaseMcpSkillExecutor | null {
  const manifest = skill.manifest;
  if (!manifest || manifest.integration !== 'http-api') return null;
  const host = manifest.allowlist.hosts[0];
  if (!host) return null;

  return {
    namespace: skill.namespace,
    manifest,
    allowedPaths: [...manifest.allowlist.pathPrefixes],
    async request({ path, method, body, chainId }) {
      if (!manifest.allowlist.pathPrefixes.some((prefix) => path.startsWith(prefix))) {
        throw new SkillPathNotAllowedError(skill.namespace, path);
      }
      const url = `https://${host}${path}`;
      return pluginHttpRequest({ plugin: skill.namespace, url, method, body, chainId });
    },
  };
}

/**
 * Loads a skill executor ONLY when the message explicitly names the
 * protocol (or, for Uniswap, unambiguous quote language) — reuses
 * `detectRuntimeSkill` rather than duplicating intent detection. Returns
 * null for any plugin without an HTTP manifest (e.g. MCP-only skills), so
 * callers never get an executor for a skill they cannot safely reach.
 */
export function loadSkillExecutorForMessage(message: string): BaseMcpSkillExecutor | null {
  const skill = detectRuntimeSkill(message);
  if (!skill) return null;
  return buildExecutor(skill);
}

/** Loads a skill executor by explicit namespace (e.g. from an already-resolved provider scope). */
export function loadSkillExecutor(namespace: string): BaseMcpSkillExecutor | null {
  const skill = getRuntimeSkill(namespace);
  if (!skill) return null;
  return buildExecutor(skill);
}
