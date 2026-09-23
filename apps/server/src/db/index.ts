import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrations } from './migrations.js';

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    const current = (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = current; v < migrations.length; v++) {
      this.tx(() => {
        this.raw.exec(migrations[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }

  /** INSERT a row object into a table. */
  insert(table: string, row: Row) {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    return this.run(sql, ...cols.map((c) => row[c]!));
  }

  /** UPDATE columns of the row with the given id; undefined values are skipped. */
  update(table: string, id: string, patch: Record<string, SQLInputValue | undefined>) {
    const cols = Object.keys(patch).filter((c) => patch[c] !== undefined);
    if (cols.length === 0) return;
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    this.run(sql, ...cols.map((c) => patch[c]!), id);
  }

  close() {
    this.raw.close();
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }
}

export const nowIso = () => new Date().toISOString();
