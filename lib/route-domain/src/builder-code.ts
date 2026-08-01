// ---------------------------------------------------------------------------
// T67X-B1 — the Builder Code, resolved in ONE place.
//
// A Builder Code is a PUBLIC attribution identifier issued by base.dev. It is
// not a credential: it names who gets credit for onchain activity, and leaking
// it costs nothing. Treating it as a secret is what produced three env names
// for one value.
//
// The three names exist because three runtimes read env differently: a server
// reads `process.env`, Vite inlines `VITE_*` at build time, Next inlines
// `NEXT_PUBLIC_*`. They are the SAME value, and this module is the only place
// that knows the precedence between them.
//
// `BASE_BUILDER_CODE` is canonical. `BUILDER_CODE` is a deprecated alias kept
// for exactly one iteration so a running deployment does not lose attribution
// the moment it pulls.
//
// The one hard rule: if both are set to DIFFERENT values, this resolves to
// `conflict` and nothing is attributed. Picking a winner would mean silently
// crediting one of two codes an operator explicitly disagreed with themselves
// about, and attribution failures are invisible — no error, no warning, just
// activity credited to nobody. Failing closed makes the disagreement loud.
// ---------------------------------------------------------------------------

/** Accepted shape. base.dev issues `bc_<hex>`, but earlier Miorail deployments
 * registered a bare word, and refusing those would drop attribution from a
 * production that is currently working. Kept as the x402 builder-code
 * extension's own pattern so one string satisfies both consumers. */
export const BUILDER_CODE_PATTERN_V1 = /^[a-z0-9_]{1,32}$/;

/** Values that mean "nobody filled this in". Treated as absent, never as a
 * code: a placeholder that reached base.dev would attribute real volume to a
 * string in a template. */
const BUILDER_CODE_PLACEHOLDERS_V1 = new Set([
  'builder_code',
  'change_me',
  'changeme',
  'example',
  'miorail-placeholder',
  'placeholder',
  'replace_me',
  'todo',
  'your_builder_code',
]);

export const BUILDER_CODE_CANONICAL_KEYS_V1 = [
  'BASE_BUILDER_CODE',
  'VITE_BASE_BUILDER_CODE',
  'NEXT_PUBLIC_BASE_BUILDER_CODE',
] as const;

export const BUILDER_CODE_DEPRECATED_KEYS_V1 = [
  'BUILDER_CODE',
  'VITE_BUILDER_CODE',
  'NEXT_PUBLIC_BUILDER_CODE',
] as const;

export type BuilderCodeSourceV1 = 'canonical' | 'deprecated_alias';

export type BuilderCodeResolutionV1 =
  | {
      status: 'resolved';
      code: string;
      source: BuilderCodeSourceV1;
      /** The env key the value actually came from. Reported so an operator can
       * find it; the value itself is public, so printing it is safe. */
      key: string;
      /** Set when the deprecated alias supplied the value, or when it agreed
       * with the canonical one. Something to remove next iteration. */
      deprecatedKeys: string[];
    }
  | { status: 'absent'; deprecatedKeys: string[] }
  | {
      /** Canonical and alias disagree. Fail closed — see the header. */
      status: 'conflict';
      canonicalKey: string;
      deprecatedKey: string;
    }
  | {
      status: 'invalid';
      key: string;
      reason: 'placeholder' | 'malformed';
    };

export type BuilderCodeEnvV1 = Readonly<Record<string, string | undefined>>;

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function firstPresent(
  env: BuilderCodeEnvV1,
  keys: readonly string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = normalized(env[key]);
    if (value !== undefined) return { key, value };
  }
  return undefined;
}

/** Resolves the Builder Code from any env-shaped record — `process.env`, a
 * parsed `.env` file, or `import.meta.env`. Pure: it reads nothing global, so
 * the deployment check and the running server cannot disagree. */
export function resolveBuilderCodeV1(env: BuilderCodeEnvV1): BuilderCodeResolutionV1 {
  const canonical = firstPresent(env, BUILDER_CODE_CANONICAL_KEYS_V1);
  const deprecated = firstPresent(env, BUILDER_CODE_DEPRECATED_KEYS_V1);
  const deprecatedKeys = BUILDER_CODE_DEPRECATED_KEYS_V1.filter(
    (key) => normalized(env[key]) !== undefined,
  );

  if (canonical && deprecated && canonical.value !== deprecated.value) {
    return {
      status: 'conflict',
      canonicalKey: canonical.key,
      deprecatedKey: deprecated.key,
    };
  }

  const chosen = canonical ?? deprecated;
  if (!chosen) return { status: 'absent', deprecatedKeys };

  if (BUILDER_CODE_PLACEHOLDERS_V1.has(chosen.value.toLowerCase())) {
    return { status: 'invalid', key: chosen.key, reason: 'placeholder' };
  }
  if (!BUILDER_CODE_PATTERN_V1.test(chosen.value)) {
    return { status: 'invalid', key: chosen.key, reason: 'malformed' };
  }

  return {
    status: 'resolved',
    code: chosen.value,
    source: canonical ? 'canonical' : 'deprecated_alias',
    key: chosen.key,
    deprecatedKeys,
  };
}

/** The code, or undefined. For callers that only need the value and handle
 * "no attribution" the same way regardless of why. */
export function builderCodeFromEnvV1(env: BuilderCodeEnvV1): string | undefined {
  const resolution = resolveBuilderCodeV1(env);
  return resolution.status === 'resolved' ? resolution.code : undefined;
}

/** One line an operator can act on, or null when nothing is wrong. Never
 * printed for `resolved` without a deprecated key — a healthy config should be
 * silent. */
export function builderCodeAdviceV1(resolution: BuilderCodeResolutionV1): string | null {
  switch (resolution.status) {
    case 'conflict':
      return `${resolution.canonicalKey} and ${resolution.deprecatedKey} are set to different values. ` +
        'Attribution is disabled until they agree — delete the deprecated one.';
    case 'invalid':
      return resolution.reason === 'placeholder'
        ? `${resolution.key} is still a placeholder; set a real code from base.dev.`
        : `${resolution.key} does not match ${BUILDER_CODE_PATTERN_V1}; get the code from base.dev.`;
    case 'absent':
      return 'No Builder Code is set. Onchain activity will be attributed to nobody. ' +
        'Set BASE_BUILDER_CODE from base.dev > Settings > Builder Codes.';
    case 'resolved':
      return resolution.source === 'deprecated_alias'
        ? `${resolution.key} is deprecated; rename it to ${resolution.key.replace('BUILDER_CODE', 'BASE_BUILDER_CODE')}.`
        : resolution.deprecatedKeys.length > 0
          ? `${resolution.deprecatedKeys.join(', ')} duplicate the canonical value and can be deleted.`
          : null;
  }
}
