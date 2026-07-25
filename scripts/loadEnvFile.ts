import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Minimal root-.env loader for the smoke scripts.
//
// The repo's convention is `node --env-file=.env`, which is easy to forget when
// a script is run through its pnpm alias — the script then sees an empty
// environment and reports "not configured" for a variable that IS set. This
// loads the root .env so `pnpm smoke:*` behaves the way its own instructions
// say it does.
//
// Two deliberate non-features:
//
//   * An already-set variable always wins. A real process environment is the
//     authority; the file only fills gaps.
//   * Inline `# comments` are NOT stripped. dotenv strips them, systemd's
//     EnvironmentFile and `docker --env-file` do NOT — so "fixing" them here
//     would make a smoke pass against a value the server never sees. They are
//     reported instead, by KEY only.
// ---------------------------------------------------------------------------

export interface LoadedEnvFileV1 {
  path: string;
  loaded: boolean;
  /** Keys whose value looks like it swallowed an inline comment. */
  suspiciousKeys: string[];
  appliedKeys: string[];
}

/** Walks up from the working directory to the workspace root. `import.meta` is
 * unavailable here (this package compiles to CommonJS), and the smoke may be
 * launched from a package directory as well as from the root. */
function repoRoot(): string {
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd());
}

export type EnvValueVerdictV1 =
  | { kind: 'value'; value: string }
  /** `KEY=   # note` — the whole value IS a comment. No credential starts with
   * `#`, so this is treated as UNSET rather than passed on: it stops a pasted
   * comment from being used as a token. */
  | { kind: 'comment_only'; value: '' }
  /** `KEY=value # note` — dotenv would strip the tail, systemd and docker would
   * not. The raw value is kept (guessing would make the smoke disagree with the
   * server) and the key is reported. */
  | { kind: 'trailing_comment'; value: string };

/** Classifies one raw `.env` value. Exported so it can be tested directly. */
export function classifyEnvValueV1(raw: string): EnvValueVerdictV1 {
  const value = raw.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  // A quoted value is unambiguous — every loader agrees on it.
  if (quoted) return { kind: 'value', value: quoted[2] };
  if (value.startsWith('#')) return { kind: 'comment_only', value: '' };
  if (/\s#/.test(value)) return { kind: 'trailing_comment', value };
  return { kind: 'value', value };
}

export function loadRootEnvFileV1(): LoadedEnvFileV1 {
  const path = resolve(repoRoot(), '.env');
  const result: LoadedEnvFileV1 = { path, loaded: false, suspiciousKeys: [], appliedKeys: [] };
  if (!existsSync(path)) return result;

  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const verdict = classifyEnvValueV1(line.slice(separator + 1));
    if (verdict.kind !== 'value') result.suspiciousKeys.push(key);

    if (process.env[key] === undefined) {
      process.env[key] = verdict.value;
      result.appliedKeys.push(key);
    }
  }
  result.loaded = true;
  return result;
}

/** Prints what was loaded. Keys only — a value is never printed. */
export function reportLoadedEnvFileV1(loaded: LoadedEnvFileV1): void {
  if (!loaded.loaded) {
    console.log(`   · no .env at ${loaded.path} — using the process environment only`);
    return;
  }
  console.log(`   · loaded ${loaded.appliedKeys.length} variable(s) from ${loaded.path}`);
  if (loaded.suspiciousKeys.length > 0) {
    console.log(
      `   ⚠ inline "#" comment in: ${loaded.suspiciousKeys.join(', ')}\n` +
        '     dotenv strips those; systemd EnvironmentFile and docker --env-file do NOT,\n' +
        '     so the server may be reading the comment as part of the value. Move each\n' +
        '     comment to its own line, or quote the value.',
    );
  }
}
