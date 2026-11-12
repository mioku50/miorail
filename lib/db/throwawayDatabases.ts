import postgres from 'postgres';

// ---------------------------------------------------------------------------
// The storage tests that need a real Postgres, run so that they cannot rot.
//
// Forty-one files (`lib/route-storage/test/*.postgres.test.ts`, the migration
// constraint tests in `lib/db`) test a repository's SQL or a migration's
// constraints by writing rows. Each one drops and rebuilds its own tables, so
// each one reads MIOAGENT_MIGRATION_TEST_URL and skips unless it names a
// database on this machine. Nothing ever set that variable: not CI, not the
// gates. Every file skipped, green, for months, and when they were finally
// run, six failed against the migrations as they are now and five more
// skipped anyway, because they insist on a database of their own name.
//
// This gives every file its own empty database on a local server, named the
// way the file asks, and counts a file that ran nothing as a failure.
// ---------------------------------------------------------------------------

/** The variable every one of these files reads. */
export const THROWAWAY_URL_ENV_V1 = 'MIOAGENT_MIGRATION_TEST_URL';

/**
 * Whether a test file is one of these: it reads the variable itself. This is
 * how the run finds them, so a new file joins without being listed anywhere.
 */
export function readsThrowawayUrlV1(source: string): boolean {
  return source.includes(`process.env.${THROWAWAY_URL_ENV_V1}`);
}

/** The production role some of these files create to test table ownership. */
export const THROWAWAY_APP_ROLE_V1 = 'miorail_user';

/** A local server a run may create databases on and drop them from. */
export interface ThrowawayServerV1 {
  user: string;
  password: string;
  port: string;
  /** The database the run itself connects to; never dropped. */
  database: string;
}

/**
 * The server named by the variable, or null unless it is plainly this machine.
 * A hosted database is never an answer here, whatever its name says.
 */
export function throwawayServerV1(raw: string | undefined): ThrowawayServerV1 | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!url.username || !database) return null;
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    port: url.port || '5432',
    database,
  };
}

/**
 * The URL a file is given. Always `postgres://…@127.0.0.1:<port>/<name>`:
 * several files accept only that host, written with its port.
 */
export function throwawayDatabaseUrlV1(server: ThrowawayServerV1, database: string): string {
  const auth = `${encodeURIComponent(server.user)}:${encodeURIComponent(server.password)}`;
  return `postgres://${auth}@127.0.0.1:${server.port}/${database}`;
}

const NAMED_DATABASE_V1 = /\/(miorail_[a-z0-9_]+_test)\b/;

/**
 * The database a file runs in. Five files refuse any database but one of their
 * own name (`…/miorail_reopen_game_test`), which is their guard against being
 * pointed at something real; they are given exactly that. The rest get a name
 * nobody else has.
 */
export function throwawayDatabaseNameV1(source: string, runId: string, index: number): string {
  const named = NAMED_DATABASE_V1.exec(source);
  if (named) return named[1]!;
  return `mio_throwaway_${runId}_${index}`;
}

/** What one file's TAP summary says it did. */
export interface ThrowawayTallyV1 {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
}

/** Reads the last TAP summary in a file's output; null when there is none. */
export function parseTapTallyV1(output: string): ThrowawayTallyV1 | null {
  const last = (name: string): number | null => {
    const all = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    const found = all[all.length - 1];
    return found ? Number(found[1]) : null;
  };
  const tests = last('tests');
  const pass = last('pass');
  const fail = last('fail');
  const skipped = last('skipped');
  if (tests === null || pass === null || fail === null || skipped === null) return null;
  return { tests, pass, fail, skipped };
}

/**
 * Why a file's run does not count, or null when it does. A file that skipped is
 * a file nobody ran: that is how these tests went unread, so it is a failure
 * here, with the same weight as a failed assertion.
 *
 * `tables` is how many tables the file left in its database. Most of these
 * files, when they decline their database, do not skip a test: they run one
 * empty test named "skipped: …", which passes. Their summary then reads one
 * passed, none skipped. What cannot be dressed up is the database itself:
 * every one of them builds its tables first, so a database still empty
 * afterwards is one the file never touched.
 */
export function throwawayRefusalV1(
  exitCode: number,
  tally: ThrowawayTallyV1 | null,
  tables: number,
): string | null {
  if (exitCode !== 0) return `exited with ${exitCode}`;
  if (!tally) return 'printed no summary';
  if (tally.fail > 0) return `${tally.fail} failed`;
  if (tally.skipped > 0) return `${tally.skipped} skipped: it did not accept the database it was given`;
  if (tally.pass === 0) return 'ran no test';
  if (tables === 0) return 'left its database empty: it did not accept the database it was given';
  return null;
}

const SAFE_NAME_V1 = /^[a-z][a-z0-9_]{0,62}$/;

export interface ThrowawayAdminV1 {
  /** Creates an empty database. Refuses a name that is already there. */
  create(database: string): Promise<void>;
  /** How many tables a database this run created now holds, in any schema of its own. */
  tableCount(database: string): Promise<number>;
  /** Drops a database this run created. */
  drop(database: string): Promise<void>;
  roleExists(role: string): Promise<boolean>;
  /** Drops a role a file created; a role that still owns something stays. */
  dropRole(role: string): Promise<void>;
  end(): Promise<void>;
}

/** The run's own connection to the server, used only to create and drop. */
export function connectThrowawayAdminV1(server: ThrowawayServerV1): ThrowawayAdminV1 {
  const sql = postgres(throwawayDatabaseUrlV1(server, server.database), { max: 1, onnotice: () => {} });
  const created = new Set<string>();
  const checked = (name: string): string => {
    if (!SAFE_NAME_V1.test(name)) throw new Error(`Refusing the name ${JSON.stringify(name)}`);
    return name;
  };
  return {
    async create(database) {
      const name = checked(database);
      const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
      if (rows.length > 0) {
        // Never dropped to make room: it may be somebody's, and this run only
        // removes what it made.
        throw new Error(`Database ${name} already exists on this server; drop it by hand if it is a leftover`);
      }
      await sql.unsafe(`CREATE DATABASE ${name}`);
      created.add(name);
    },
    async tableCount(database) {
      const name = checked(database);
      if (!created.has(name)) throw new Error(`Database ${name} is not one this run created`);
      const inside = postgres(throwawayDatabaseUrlV1(server, name), { max: 1, onnotice: () => {} });
      try {
        const [row] = await inside<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        `;
        return row?.n ?? 0;
      } finally {
        await inside.end({ timeout: 5 });
      }
    },
    async drop(database) {
      const name = checked(database);
      if (!created.has(name)) return;
      await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      created.delete(name);
    },
    async roleExists(role) {
      const rows = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
      return rows.length > 0;
    },
    async dropRole(role) {
      const name = checked(role);
      try {
        // What it was granted in the run's own database goes first; the tables
        // it owned went with the file's database.
        await sql.unsafe(`DROP OWNED BY ${name}`);
        await sql.unsafe(`DROP ROLE IF EXISTS ${name}`);
      } catch {
        // Still owning something elsewhere: leave it, the next file copes.
      }
    },
    async end() {
      await sql.end({ timeout: 5 });
    },
  };
}
