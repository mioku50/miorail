import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

// ---------------------------------------------------------------------------
// Every writer of a reviewed representation binding, by name.
//
// The write gate refuses an incomplete binding at runtime and `tsc` refuses it
// at build time, so this file is not what stops a bad write -- it is what stops
// the SET of writers from growing quietly. A third script that binds
// representations has to be added here, which is where somebody reads the rule.
// ---------------------------------------------------------------------------
const WRITERS_V1 = [
  // Phase 17.5. Dinari's dShares: the issuer's own address list when it names
  // the Base contract, and otherwise a symbol join whose BOTH sides are that
  // same issuer's publications, gated on a composite FIGI the registry that
  // issues FIGIs agrees with.
  'scripts/rwa_bind_dinari_representations.ts',
  'scripts/rwa_enrich_underlying_identity.ts',
  'scripts/rwa_ingest_official.ts',
] as const;

const REQUIRED_FIELDS_V1 = ['issuerId', 'issuerInstrumentKey', 'representationKind'] as const;

function sourcesThatBindV1(): string[] {
  const roots = ['scripts', path.join('lib', 'route-storage', 'src'), 'artifacts'];
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
      const text = readFileSync(full, 'utf8');
      if (/\.bindRepresentation\(\s*\{/.test(text)) {
        found.push(path.relative(repoRoot, full).split(path.sep).join('/'));
      }
    }
  };
  for (const root of roots) walk(path.join(repoRoot, root));
  return found.sort();
}

describe('every writer establishes complete typed identity', () => {
  test('the set of binding writers is exactly the reviewed three', () => {
    assert.deepEqual(sourcesThatBindV1(), [...WRITERS_V1]);
  });

  for (const writer of WRITERS_V1) {
    test(`${writer} supplies all three identity fields`, () => {
      const text = readFileSync(path.join(repoRoot, writer), 'utf8');
      const call = text.slice(text.indexOf('.bindRepresentation({'));
      const body = call.slice(0, call.indexOf('});') + 3);
      for (const field of REQUIRED_FIELDS_V1) {
        assert.match(body, new RegExp(`\\b${field}:`), `${writer} must set ${field}`);
      }
      // And it must not reach for a name or a ticker to fill one in.
      for (const field of REQUIRED_FIELDS_V1) {
        const assignment = new RegExp(`\\b${field}:\\s*([^,\\n]+)`);
        const value = body.match(assignment)?.[1] ?? '';
        assert.doesNotMatch(
          value,
          /\b(symbol|ticker|displaySymbol|canonicalName|name)\b/i,
          `${writer} must not derive ${field} from a name or ticker`,
        );
        assert.doesNotMatch(value, /'unknown'|"unknown"/, `${writer} must not write "unknown"`);
      }
    });
  }
});
