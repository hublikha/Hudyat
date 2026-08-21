import { Db, SqlValue, migrate } from '@rcn/core';
import * as SQLite from 'expo-sqlite';

/**
 * `Db` backed by expo-sqlite.
 *
 * The synchronous API is used deliberately. Persist-before-send writes a
 * message, its sequence number and its sealed frame in one transaction, and an
 * `await` inside that sequence would let a transport callback interleave and
 * observe — or worse, act on — a half-written message.
 *
 * This is the only file in the app that names expo-sqlite. The domain sees the
 * `Db` interface, which is what lets the same code be tested against
 * `node:sqlite` in `@rcn/core`.
 */

const DATABASE_NAME = 'rcn.db';

export class ExpoDb implements Db {
  readonly #db: SQLite.SQLiteDatabase;

  constructor(db: SQLite.SQLiteDatabase) {
    this.#db = db;
  }

  static open(name = DATABASE_NAME): ExpoDb {
    return new ExpoDb(SQLite.openDatabaseSync(name));
  }

  exec(sql: string): void {
    this.#db.execSync(sql);
  }

  run(sql: string, params: readonly SqlValue[] = []): void {
    this.#db.runSync(sql, params as SQLite.SQLiteBindValue[]);
  }

  all<T>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.#db.getAllSync<T>(sql, params as SQLite.SQLiteBindValue[]);
  }

  get<T>(sql: string, params: readonly SqlValue[] = []): T | undefined {
    return this.#db.getFirstSync<T>(sql, params as SQLite.SQLiteBindValue[]) ?? undefined;
  }

  close(): void {
    this.#db.closeSync();
  }
}

let opened: ExpoDb | null = null;

/**
 * Opens the database and applies migrations once per process.
 *
 * Migration failure is deliberately not caught. A database that did not reach
 * the schema this build expects will fail in confusing ways later — a missing
 * column surfaces as a message that will not send — and the honest outcome is a
 * visible failure at startup rather than a family discovering it mid-emergency.
 */
export function openDatabase(): Db {
  if (opened === null) {
    const db = ExpoDb.open();
    migrate(db);
    opened = db;
  }
  return opened;
}
