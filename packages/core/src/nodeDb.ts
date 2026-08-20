import { DatabaseSync } from 'node:sqlite';

import { Db, SqlValue } from './database';

/**
 * `Db` backed by Node's built-in SQLite.
 *
 * This exists for tests. It is the same SQLite engine the device runs, so a
 * constraint or trigger that holds here holds there — which is the point.
 * Phase 0 taught the opposite lesson the hard way: the protocol tests passed in
 * Node while the code could not run on Hermes at all, because Node supplied a
 * global the device lacked. Here the engine is genuinely shared, so these tests
 * carry weight the UTF-8 tests did not.
 *
 * The driver differs, and only the driver. Anything relying on a Node-only
 * behaviour of `node:sqlite` rather than on SQLite itself would be untrustworthy
 * for the same reason.
 */
export class NodeDb implements Db {
  readonly #db: DatabaseSync;

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, params: readonly SqlValue[] = []): void {
    this.#db.prepare(sql).run(...(params as SqlValue[]));
  }

  all<T>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.#db.prepare(sql).all(...(params as SqlValue[])) as T[];
  }

  get<T>(sql: string, params: readonly SqlValue[] = []): T | undefined {
    return this.#db.prepare(sql).get(...(params as SqlValue[])) as T | undefined;
  }

  close(): void {
    this.#db.close();
  }
}
