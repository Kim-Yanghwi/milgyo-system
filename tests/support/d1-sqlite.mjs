// D1 API adapter for local security tests, backed by real SQLite, not an SQL-pattern mock.
// Cloudflare's deployment/runtime and quota behaviour must still be tested in Preview.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
export class SQLiteD1 {
  constructor({ migrate = true, auth = true } = {}) {
    this.sqlite = new DatabaseSync(':memory:');
    this.beforeRun = null;
    this.beforeBatch = null;
    if (migrate) {
      for (const name of readdirSync('migrations/main').filter(n => n.endsWith('.sql')).sort()) {
        if (!auth && name.startsWith('0012')) continue;
        this.sqlite.exec(readFileSync(`migrations/main/${name}`, 'utf8'));
      }
    }
  }
  prepare(sql) {
    const owner = this;
    const make = (params = []) => ({
      sql, params,
      bind(...args) { return make(args); },
      async run() { if (owner.beforeRun) owner.beforeRun(this); return owner.execute(this); },
      async all() { if (owner.beforeRun) owner.beforeRun(this); return owner.execute(this); },
      async first(column) { if (owner.beforeRun) owner.beforeRun(this); const row = owner.execute(this).results[0] ?? null; return column ? row?.[column] ?? null : row; },
      async raw() { return owner.execute(this).results.map(row => Object.values(row)); },
    });
    return make();
  }
  execute({ sql, params }) {
    const stmt = this.sqlite.prepare(sql);
    const values = params.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const results = stmt.columns().length ? stmt.all(...values).map(row => ({ ...row })) : (stmt.run(...values), []);
    const meta = this.sqlite.prepare('SELECT changes() AS changes,last_insert_rowid() AS last_row_id').get();
    return { success: true, results, meta: { ...meta, duration: 0 } };
  }
  async batch(statements) {
    if (this.beforeBatch) this.beforeBatch(statements);
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(s => this.execute(s)); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  async exec(sql) { this.sqlite.exec(sql); return { count: 1, duration: 0 }; }
  close() { this.sqlite.close(); }
}
export class TestR2 {
  objects = new Map();
  deleted = [];
  async put(key, value) { this.objects.set(key, value); return {}; }
  async delete(key) { for (const item of Array.isArray(key) ? key : [key]) { this.deleted.push(item); this.objects.delete(item); } }
  async get(key) { const value = this.objects.get(key); return value ? { body: new Blob([value]).stream(), arrayBuffer: () => new Blob([value]).arrayBuffer(), size: value.length } : null; }
}
