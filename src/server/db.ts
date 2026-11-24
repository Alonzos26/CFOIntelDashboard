import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

type P = string | number | null;
/** Thin data-access port. Swap this class for a PostgreSQL implementation in production (see docs/ARCHITECTURE.md). */
export class Db {
  raw: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.raw.exec(readFileSync(join(import.meta.dirname, '../../db/schema.sqlite.sql'), 'utf8'));
    // Columns added after the first release: CREATE TABLE IF NOT EXISTS does not alter an existing database.
    for (const [table, column, type] of [['weekly_entries', 'other_labor_cents', 'INTEGER'], ['import_batches', 'accounting_basis', "TEXT NOT NULL DEFAULT 'unknown'"]]) if (!(this.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)) this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  all<T = Record<string, any>>(sql: string, ...params: P[]): T[] { return this.raw.prepare(sql).all(...params) as T[]; }
  get<T = Record<string, any>>(sql: string, ...params: P[]): T | undefined { return this.raw.prepare(sql).get(...params) as T | undefined; }
  run(sql: string, ...params: P[]) { return this.raw.prepare(sql).run(...params); }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.raw.exec('COMMIT'); return r; } catch (e) { this.raw.exec('ROLLBACK'); throw e; }
  }
  audit(tenantId: string | null, userId: string | null, action: string, entity?: string, entityId?: string, detail?: unknown) {
    this.run('INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?)', tenantId, userId, action, entity ?? null, entityId ?? null, detail === undefined ? null : JSON.stringify(detail), now());
  }
  close() { this.raw.close(); }
}
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
