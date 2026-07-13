import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [
  'artifacts/api-server/index.ts',
  'artifacts/interface/src/main.tsx',
  'artifacts/miniapp/app/layout.tsx',
  'artifacts/miniapp/app/page.tsx',
];
const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const forbiddenModule = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?|testing)(?:\/|\.)|(?:^|\/)(?:mock|fixture)[._-]|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const importPattern = /(?:\bimport\s*(?:[^'"()]*?\s+from\s*)?|\bexport\s+[^'"()]*?\s+from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function existingModule(candidate) {
  for (const extension of extensions) {
    const file = `${candidate}${extension}`;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  for (const extension of extensions.slice(1)) {
    const file = path.join(candidate, `index${extension}`);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function packageEntry(specifier) {
  if (!specifier.startsWith('@mioagent/')) return null;
  const [, packageName, ...subpathParts] = specifier.split('/');
  const packageDirCandidates = [
    path.join(repo, 'lib', packageName),
    path.join(repo, 'artifacts', packageName),
  ];
  const packageDir = packageDirCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (!packageDir) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const subpath = subpathParts.join('/');
  if (subpath) {
    const exported = manifest.exports?.[`./${subpath}`];
    if (typeof exported === 'string') return existingModule(path.resolve(packageDir, exported));
    return existingModule(path.join(packageDir, 'src', subpath));
  }
  const exported = typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : null;
  return existingModule(path.resolve(packageDir, exported || manifest.main || 'src/index.ts'));
}

function resolveImport(fromFile, specifier) {
  if (specifier.startsWith('.')) return existingModule(path.resolve(path.dirname(fromFile), specifier));
  return packageEntry(specifier);
}

test('production dependency graph contains no test, fixture, or mock modules', () => {
  const queue = roots.map((root) => path.join(repo, root));
  const visited = new Set();
  const violations = [];

  while (queue.length) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const relative = path.relative(repo, file).replaceAll(path.sep, '/');
    if (forbiddenModule.test(relative)) violations.push(`forbidden module: ${relative}`);
    const source = fs.readFileSync(file, 'utf8');
    if (/\b(?:MOCK_|USE_MOCK_)[A-Z0-9_]*/.test(source)) violations.push(`mock env switch: ${relative}`);
    if (/\b(?:runtimeMode|providerMode|mode)\s*={0,2}\s*['"]mock['"]/.test(source)) violations.push(`mock runtime mode: ${relative}`);

    importPattern.lastIndex = 0;
    for (let match = importPattern.exec(source); match; match = importPattern.exec(source)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved) queue.push(resolved);
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'));
  assert.ok(visited.size > 40, `graph traversal was unexpectedly small (${visited.size} modules)`);
});

test('Base App wallet connector precedes popup connectors in both production UIs', () => {
  for (const file of ['artifacts/interface/src/main.tsx', 'artifacts/miniapp/app/wagmi.ts']) {
    const source = fs.readFileSync(path.join(repo, file), 'utf8');
    assert.ok(source.indexOf('injected()') < source.indexOf('baseAccount('), `${file}: injected connector must be first`);
    assert.doesNotMatch(source, /coinbaseWallet\s*\(/, `${file}: redundant popup connector must be absent`);
  }
  const server = fs.readFileSync(path.join(repo, 'artifacts/api-server/app.ts'), 'utf8');
  assert.match(server, /same-origin-allow-popups/, 'OAuth popup must retain window.opener');
  assert.doesNotMatch(server, /origin:\s*process\.env\.CORS_ORIGIN\s*\|\|\s*['"]\*['"]/, 'credentialed CORS cannot use a wildcard origin');
});

test('production dev and smoke HTTP routes are operator protected or absent', () => {
  const x402 = fs.readFileSync(path.join(repo, 'artifacts/api-server/routes/x402/index.ts'), 'utf8');
  assert.match(x402, /router\.post\('\/buyer-smoke',\s*requireDiagnosticsAdmin,/);
  assert.doesNotMatch(x402, /mock-paid-endpoint/);

  const actions = fs.readFileSync(path.join(repo, 'artifacts/api-server/routes/actions.ts'), 'utf8');
  assert.match(actions, /actionsRouter\.delete\('\/demo',\s*requireOperatorAuth,/);
});

test('x402 runtime has no mock or synthetic-success status path', () => {
  const gateway = fs.readFileSync(path.join(repo, 'lib/x402-gateway/src/index.ts'), 'utf8');
  assert.doesNotMatch(gateway, /MockFacilitator|legacyMockPaymentRequired|mockFacilitatorEnabled/);
  assert.doesNotMatch(gateway, /\|\s*['"]simulated['"]/);
  assert.match(gateway, /throw new Error\('x402_payment_configuration_incomplete'\)/);
});
