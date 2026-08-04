import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { assertSafeTestDatabaseEnvironment } from '../lib/db/testDatabaseGuard';

const root = resolve(process.cwd());
const suite = process.argv[2];

const DB_TEST_FILES = new Set([
  'artifacts/api-server/routes/chat.test.ts',
  'lib/agent/src/scheduler/index.test.ts',
  'lib/agent/src/scheduler/load.test.ts',
  'lib/agent/test/e2e-sepolia.test.ts',
  'lib/agent/test/e2e.test.ts',
  'lib/db/src/db.test.ts',
  'lib/observability/src/index.test.ts',
  'lib/route-storage/test/database.test.ts',
  'lib/settings/tests/index.test.ts',
]);

const ignoredDirectories = new Set([
  '.git', '.next', 'coverage', 'dist', 'node_modules', 'playwright-report', 'test-results',
]);

async function testFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await testFiles(join(directory, entry.name)));
      continue;
    }
    // `.tsx` included since T70: lib/ui's rendering tests are written in JSX,
    // and three of them had never been executed by this runner at all.
    if (/\.test\.(?:tsx|ts|js|mjs)$/.test(entry.name)) {
      files.push(relative(root, join(directory, entry.name)).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = root): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolveRun(code ?? 1);
    });
  });
}

function packageDirectory(file: string): string {
  const parts = file.split('/');
  if ((parts[0] === 'lib' || parts[0] === 'artifacts') && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return '.';
}

async function runGroupedTests(files: string[], env: NodeJS.ProcessEnv, concurrency: number): Promise<number> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const directory = packageDirectory(file);
    const packageFiles = groups.get(directory) ?? [];
    packageFiles.push(directory === '.' ? file : file.slice(directory.length + 1));
    groups.set(directory, packageFiles);
  }
  for (const [directory, packageFiles] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`Test group ${directory}: ${packageFiles.length} file(s).`);
    const code = await run(
      'node',
      ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, ...packageFiles],
      env,
      resolve(root, directory),
    );
    if (code !== 0) return code;
  }
  return 0;
}

async function runUnitTests(): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', MIOAGENT_TEST_SUITE: 'unit' };
  // Unit tests must not know either database URL and lib/db stays disconnected.
  delete env.DATABASE_URL;
  delete env.TEST_DATABASE_URL;
  delete env.MIOAGENT_TEST_RUN_ID;
  delete env.MIOAGENT_TEST_TENANT_ID;
  delete env.MIOAGENT_TEST_WALLET;
  const files = (await testFiles(root)).filter((file) => !DB_TEST_FILES.has(file));
  console.log(`Running ${files.length} unit test files with database access disabled.`);
  return runGroupedTests(files, env, 4);
}

async function runDatabaseTests(): Promise<number> {
  const runId = `t46-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const wallet = `0x${createHash('sha256').update(runId).digest('hex').slice(0, 40)}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    MIOAGENT_TEST_SUITE: 'db',
    MIOAGENT_TEST_RUN_ID: runId,
    MIOAGENT_TEST_TENANT_ID: `mio-test:${runId}:tenant`,
    MIOAGENT_TEST_WALLET: wallet,
  };
  const connection = assertSafeTestDatabaseEnvironment(env);
  console.log(`Database test guard accepted fingerprint ${connection.identity!.fingerprint}; production .env was not loaded.`);

  let exitCode = 1;
  try {
    const schemaCode = await run('pnpm', ['--filter', '@mioagent/db', 'run', 'push:test'], env);
    if (schemaCode !== 0) {
      exitCode = schemaCode;
    } else {
      exitCode = await runGroupedTests([...DB_TEST_FILES].sort(), env, 1);
    }
  } finally {
    const cleanupCode = await run('pnpm', ['--filter', '@mioagent/db', 'run', 'cleanup:test'], env);
    if (cleanupCode !== 0 && exitCode === 0) exitCode = cleanupCode;
  }
  return exitCode;
}

async function main(): Promise<void> {
  if (suite !== 'unit' && suite !== 'db') {
    console.error('Usage: node --import tsx scripts/run-tests.ts <unit|db>');
    process.exitCode = 2;
    return;
  }

  process.exitCode = suite === 'unit' ? await runUnitTests() : await runDatabaseTests();
}

void main();
