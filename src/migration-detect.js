const fs = require('fs');
const path = require('path');

// Zero-config database-migration discovery: scans common migration
// directories in the repo the SDK is running from (process.cwd()), same
// "best-effort static file scan, no per-format parser dependency" idiom as
// pipeline-detect.js/iac-detect.js.
//
// IMPORTANT LIMITATION, stated rather than hidden: a migration file existing
// on disk is not proof it was ever run against a real database — this does
// NOT query a migrations-tracking table (schema_migrations/knex_migrations/
// alembic_version/etc.) in the target database, just list files on disk.
// `applied_at` is therefore the file's own mtime, a best-effort proxy for
// "when this migration was added to the repo," not a guarantee it ran at
// that time in this environment. Good enough for approximate "was there a
// recent migration near this error" correlation; not a substitute for real
// migration-run telemetry.

const MAX_MIGRATIONS_REPORTED = 30;

function safeStatMtime(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Generic timestamp-prefixed migration files: knex, Sequelize, TypeORM, most
// hand-rolled Node migration runners, Rails' db/migrate, Alembic's
// versions/, and Flyway's db/migration/ all follow this "one file per
// migration" shape closely enough to share one scanner.
function scanFlatMigrationDir(dir, tool, extRe) {
  return safeReaddir(dir)
    .filter((entry) => entry.isFile() && extRe.test(entry.name))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      return { tool, migration_name: entry.name, file_path: filePath, applied_at: safeStatMtime(filePath) };
    });
}

// Prisma nests each migration in its own directory:
// prisma/migrations/<timestamp>_<name>/migration.sql
function scanPrismaMigrations(cwd) {
  const dir = path.join(cwd, 'prisma', 'migrations');
  return safeReaddir(dir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const migrationFile = path.join(dir, entry.name, 'migration.sql');
      const statTarget = fs.existsSync(migrationFile) ? migrationFile : path.join(dir, entry.name);
      return {
        tool: 'prisma',
        migration_name: entry.name,
        file_path: path.join('prisma', 'migrations', entry.name).replace(/\\/g, '/'),
        applied_at: safeStatMtime(statTarget),
      };
    });
}

function detectMigrations(cwd = process.cwd()) {
  const found = [
    ...scanFlatMigrationDir(path.join(cwd, 'migrations'), 'generic', /\.(js|ts|sql|py)$/i),
    ...scanFlatMigrationDir(path.join(cwd, 'db', 'migrate'), 'rails', /\.rb$/i),
    ...scanFlatMigrationDir(path.join(cwd, 'alembic', 'versions'), 'alembic', /\.py$/i),
    ...scanFlatMigrationDir(path.join(cwd, 'db', 'migration'), 'flyway', /^V.+\.sql$/i),
    ...scanPrismaMigrations(cwd),
  ];

  // Most-recent-first, capped — bounds payload size on repos with a long
  // migration history; only recent migrations are useful for error
  // correlation anyway.
  return found
    .filter((m) => m.applied_at)
    .sort((a, b) => new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime())
    .slice(0, MAX_MIGRATIONS_REPORTED);
}

module.exports = { detectMigrations };
