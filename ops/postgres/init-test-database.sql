-- Runs once, on first initialisation of the data volume.
--
-- `pnpm test:db` refuses to share a database with DATABASE_URL: the guard in
-- lib/db/testDatabaseGuard.ts rejects a TEST_DATABASE_URL whose normalised
-- host, port AND database all match the production one. Sharing the server is
-- fine; the database name is what has to differ. Without this, the first
-- `pnpm test:db` on a fresh machine fails with a refusal that reads like a
-- misconfiguration rather than the safety rule it is.
CREATE DATABASE miorail_test OWNER miorail;
