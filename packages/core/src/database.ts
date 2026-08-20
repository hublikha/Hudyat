import { MIGRATIONS } from './schema';

export type SqlValue = string | number | null | Uint8Array;

/**
 * The persistence surface the domain is allowed to use.
 *
 * Deliberately small and synchronous. Both `node:sqlite` and `expo-sqlite`
 * provide a synchronous API, and keeping it sync means a persist-before-send
 * step cannot accidentally interleave with a transport callback and leave a
 * message half-recorded.
 *
 * Nothing above this interface may name a driver type, for the same reason the
 * protocol may not name a transport SDK: swapping the driver must not reach the
 * domain.
 */
export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): void;
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  get<T>(sql: string, params?: readonly SqlValue[]): T | undefined;
  close(): void;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly appliedVersion: number,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

function userVersion(db: Db): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * Applies pending migrations in order.
 *
 * Each migration runs inside its own transaction together with the
 * `user_version` bump, so a failure leaves the database at the last version
 * that fully applied. A partial upgrade that still reported success would be
 * worse than a failed one: the app would read a schema it believes is complete.
 *
 * Foreign keys are enabled per connection, not per database — SQLite defaults
 * them off, and a schema whose references are silently unenforced would let
 * orphaned trust records and messages accumulate unnoticed.
 */
export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): number {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');

  let version = userVersion(db);

  if (version > migrations.length) {
    throw new MigrationError(
      `database is at version ${version}, newer than this build understands (${migrations.length}); ` +
        'refusing to run rather than corrupt state written by a later version',
      version,
    );
  }

  while (version < migrations.length) {
    const next = version + 1;
    const sql = migrations[version]!;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${next}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new MigrationError(
        `migration ${next} failed: ${(error as Error).message}`,
        version,
      );
    }
    version = next;
  }

  return version;
}

/**
 * Runs `fn` in a transaction, rolling back on any throw.
 *
 * Used for every multi-statement domain operation. Persisting a message and
 * inserting its outbox row must be one unit: a message that exists with no
 * outbox row is silently never sent, which is precisely the ambiguous outcome
 * the phase forbids.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing would mask the real error; the original is what the
      // caller needs to see.
    }
    throw error;
  }
}
