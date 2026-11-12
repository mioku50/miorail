import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { assertSafeTestDatabaseEnvironment } from '../lib/db/testDatabaseGuard';
import {
  connectThrowawayAdminV1,
  parseTapTallyV1,
  readsThrowawayUrlV1,
  THROWAWAY_APP_ROLE_V1,
  THROWAWAY_URL_ENV_V1,
  throwawayDatabaseNameV1,
  throwawayDatabaseUrlV1,
  throwawayRefusalV1,
  throwawayServerV1,
} from '../lib/db/throwawayDatabases';

const root = resolve(process.cwd());
const suite = process.argv[2];

const DB_TEST_FILES = new Set([
  'artifacts/api-server/routes/chat.test.ts',
  'lib/agent/src/scheduler/index.test.ts',
  'lib/agent/src/scheduler/load.test.ts',
  'lib/agent/test/e2e-sepolia.test.ts',
  'lib/agent/test/e2e.test.ts',
  'lib/db/src/db.test.ts',
  'lib/db/migration0064.constraints.test.ts',
  'lib/db/lending0091.postgres.test.ts',
  'lib/db/spend0095.postgres.test.ts',
  'lib/observability/src/index.test.ts',
  'lib/route-storage/test/database.test.ts',
  'lib/settings/tests/index.test.ts',
]);

const ignoredDirectories = new Set([
  '.git', '.next', 'coverage', 'dist', 'node_modules', 'playwright-report', 'test-results',
  // Local production/media work is not project source. Unpacked video skills
  // can contain their own tests for tools this workspace does not install.
  'work', 'brag-output',
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

/** Like `run`, with the child's output also kept, to read what it says it did. */
function runCaptured(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'], shell: false });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolveRun({ code: code ?? 1, output });
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
  // The storage files are also listed here, where they skip. Left set, this
  // variable would start all of them in one shared database, which is not a
  // run of them: `test:storage` gives each its own.
  delete env[THROWAWAY_URL_ENV_V1];
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

/**
 * The repositories' SQL and the migrations' constraints, each file alone in an
 * empty database of its own on a local Postgres. See lib/db/throwawayDatabases.ts
 * for why a skipped file fails this run.
 */
async function runStorageTests(): Promise<number> {
  const server = throwawayServerV1(process.env[THROWAWAY_URL_ENV_V1]);
  if (!server) {
    console.error(
      `${THROWAWAY_URL_ENV_V1} must name a Postgres on this machine, for example\n`
      + '  docker run -d --rm --name mio-pg18-test -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:18-alpine\n'
      + `  ${THROWAWAY_URL_ENV_V1}=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm test:storage`,
    );
    return 2;
  }
  // Found by the variable they read, not by a list: a new file joins by itself.
  const files: Array<{ file: string; source: string }> = [];
  for (const file of await testFiles(root)) {
    if (DB_TEST_FILES.has(file)) continue;
    const source = await readFile(resolve(root, file), 'utf8');
    if (readsThrowawayUrlV1(source)) files.push({ file, source });
  }
  if (files.length === 0) {
    console.error('No storage test file was found; refusing to call that a pass.');
    return 1;
  }
  console.log(`Running ${files.length} storage test files, each in its own empty database.`);

  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const admin = connectThrowawayAdminV1(server);
  const refused: string[] = [];
  let passed = 0;
  try {
    for (const [index, { file, source }] of files.entries()) {
      const database = throwawayDatabaseNameV1(source, runId, index + 1);
      const directory = packageDirectory(file);
      const roleWasThere = await admin.roleExists(THROWAWAY_APP_ROLE_V1);
      await admin.create(database);
      let refusal: string | null;
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NODE_ENV: 'test',
          MIOAGENT_TEST_SUITE: 'unit',
          [THROWAWAY_URL_ENV_V1]: throwawayDatabaseUrlV1(server, database),
        };
        delete env.DATABASE_URL;
        delete env.TEST_DATABASE_URL;
        const { code, output } = await runCaptured(
          'node',
          ['--import', 'tsx', '--test', '--test-reporter=tap', directory === '.' ? file : file.slice(directory.length + 1)],
          env,
          resolve(root, directory),
        );
        const tally = parseTapTallyV1(output);
        refusal = throwawayRefusalV1(code, tally, await admin.tableCount(database));
        if (refusal) {
          process.stdout.write(output);
          console.log(`REFUSED ${file}: ${refusal}`);
          refused.push(`${file}: ${refusal}`);
        } else {
          passed += tally!.pass;
          console.log(`ok ${file} (${tally!.pass} passed)`);
        }
      } finally {
        await admin.drop(database);
        // A file that made the production role leaves the server as it found
        // it, so the next file again starts where a fresh clone does: with no
        // such role.
        if (!roleWasThere) await admin.dropRole(THROWAWAY_APP_ROLE_V1);
      }
    }
  } finally {
    await admin.end();
  }
  if (refused.length > 0) {
    console.error(`\n${refused.length} of ${files.length} storage test files did not pass:`);
    for (const line of refused) console.error(`  ${line}`);
    return 1;
  }
  console.log(`All ${files.length} storage test files passed (${passed} tests).`);
  return 0;
}

async function main(): Promise<void> {
  if (suite !== 'unit' && suite !== 'db' && suite !== 'storage') {
    console.error('Usage: node --import tsx scripts/run-tests.ts <unit|db|storage>');
    process.exitCode = 2;
    return;
  }

  process.exitCode = suite === 'unit'
    ? await runUnitTests()
    : suite === 'db'
      ? await runDatabaseTests()
      : await runStorageTests();
}

void main();
