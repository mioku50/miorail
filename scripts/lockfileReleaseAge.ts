// ---------------------------------------------------------------------------
// No version in the lockfile younger than the policy's week (audit SUP-1, 2026-11-14).
//
// pnpm-workspace.yaml refuses to resolve any package published within the last
// seven days. Dependabot's security updates are allowed past that by Dependabot
// itself ("minimumReleaseAge (10080 minutes, 7 days) is bypassed for this
// security update", 2026-11-13), and nothing downstream checked again: CI and
// the deploy both install with --frozen-lockfile, which never resolves, so it
// never asks a version's age. A version hurried out under a stolen maintainer
// account, inside an advisory's "patched" range, would have gone from a green
// pull request to the server within hours.
//
// So CI reads every name@version a change adds to pnpm-lock.yaml, asks the
// registry when each was published, and fails while any is younger than the
// policy's minimum. The only way past it is a line in
// .github/release-age-exceptions.txt, which is a reviewed commit of its own.
// ---------------------------------------------------------------------------

/** Every `name@version` the lockfile's `packages:` section resolves. */
export function lockfilePackagesV1(lockfile: string): Set<string> {
  const out = new Set<string>();
  let inPackages = false;
  for (const line of lockfile.split('\n')) {
    if (/^\S/.test(line)) { inPackages = line.trimEnd() === 'packages:'; continue; }
    if (!inPackages) continue;
    const match = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s'/]+)@([^\s'():]+)'?:\s*$/.exec(line);
    if (match) out.add(`${match[1]}@${match[2]}`);
  }
  return out;
}

/** What the head lockfile resolves that the base one did not, sorted. */
export function addedPackagesV1(base: string, head: string): string[] {
  const before = lockfilePackagesV1(base);
  return [...lockfilePackagesV1(head)].filter((entry) => !before.has(entry)).sort();
}

/** The policy's minimum, in minutes, as pnpm-workspace.yaml sets it; null when it says none. */
export function minimumReleaseAgeMinutesV1(workspace: string): number | null {
  const match = /^minimumReleaseAge:\s*(\d+)\b/m.exec(workspace);
  return match ? Number(match[1]) : null;
}

/** The exceptions file: one `name@version` a line, then a reason; `#` begins a comment. */
export function releaseAgeExceptionsV1(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const entry = line.replace(/#.*$/, '').trim().split(/\s+/)[0];
    if (entry && /^(?:@[^/@\s]+\/)?[^@\s/]+@\S+$/.test(entry)) out.add(entry);
  }
  return out;
}

export type ReleaseAgeFindingV1 =
  | { entry: string; state: 'too_young'; publishedAt: string; ageMinutes: number }
  | { entry: string; state: 'unread' };

/** The added versions younger than the minimum, or whose publication could not be read. An exception passes. */
export function releaseAgeFindingsV1(input: {
  added: readonly string[];
  publishedAt: ReadonlyMap<string, string | null>;
  now: Date;
  minimumMinutes: number;
  exceptions: ReadonlySet<string>;
}): ReleaseAgeFindingV1[] {
  const findings: ReleaseAgeFindingV1[] = [];
  for (const entry of input.added) {
    if (input.exceptions.has(entry)) continue;
    const published = input.publishedAt.get(entry) ?? null;
    const at = published === null ? Number.NaN : Date.parse(published);
    if (!Number.isFinite(at)) { findings.push({ entry, state: 'unread' }); continue; }
    const ageMinutes = Math.floor((input.now.getTime() - at) / 60_000);
    if (ageMinutes < input.minimumMinutes) findings.push({ entry, state: 'too_young', publishedAt: new Date(at).toISOString(), ageMinutes });
  }
  return findings;
}

/** Splits `name@version` at the version's @, a scope's own @ kept. */
export function packageOfEntryV1(entry: string): { name: string; version: string } {
  const at = entry.lastIndexOf('@');
  return { name: entry.slice(0, at), version: entry.slice(at + 1) };
}

/** When the registry says each version was published, read once per name. A failed read is null. */
export async function readPublishedAtV1(entries: readonly string[], fetchImpl: typeof fetch = fetch,
  registry = 'https://registry.npmjs.org'): Promise<Map<string, string | null>> {
  const byName = new Map<string, string[]>();
  for (const entry of entries) {
    const { name, version } = packageOfEntryV1(entry);
    byName.set(name, [...(byName.get(name) ?? []), version]);
  }
  const out = new Map<string, string | null>();
  for (const [name, versions] of byName) {
    let time: Record<string, unknown> | null = null;
    try {
      const response = await fetchImpl(`${registry}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      if (response.ok) {
        const document = await response.json() as { time?: unknown };
        if (document.time !== null && typeof document.time === 'object') time = document.time as Record<string, unknown>;
      }
    } catch { /* unread: the check fails closed */ }
    for (const version of versions) {
      const value = time?.[version];
      out.set(`${name}@${version}`, typeof value === 'string' ? value : null);
    }
  }
  return out;
}
