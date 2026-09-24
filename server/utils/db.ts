import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

let connection: Database.Database | undefined
let orm: ReturnType<typeof drizzle<typeof schema>> | undefined

export function getDatabase() {
  if (!orm) {
    const path = resolve(process.env.DATABASE_PATH || '.data/optimizer.sqlite')
    mkdirSync(dirname(path), { recursive: true })
    connection = new Database(path)
    connection.pragma('journal_mode = WAL')
    connection.pragma('foreign_keys = ON')
    connection.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, prefix TEXT NOT NULL, status TEXT NOT NULL,
        discovered_count INTEGER NOT NULL DEFAULT 0, jpeg_count INTEGER NOT NULL DEFAULT 0,
        metadata_error_count INTEGER NOT NULL DEFAULT 0, cursor TEXT, error TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS objects (
        key TEXT PRIMARY KEY, scan_id INTEGER NOT NULL REFERENCES scans(id),
        etag TEXT, size INTEGER NOT NULL, last_modified TEXT,
        is_jpeg INTEGER NOT NULL, is_optimized INTEGER, metadata_status TEXT NOT NULL,
        metadata_error TEXT, optimizer_version TEXT, optimized_size INTEGER,
        saved_percent INTEGER, discovered_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS objects_scan_id_idx ON objects(scan_id);
      CREATE TABLE IF NOT EXISTS optimization_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, preset TEXT NOT NULL,
        minimum_saving_percent INTEGER NOT NULL DEFAULT 15, backup_originals INTEGER NOT NULL DEFAULT 1,
        preserve_metadata INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS optimization_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES optimization_jobs(id),
        key TEXT NOT NULL, etag TEXT, original_size INTEGER NOT NULL, optimized_size INTEGER,
        saved_percent INTEGER, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS optimization_items_job_id_idx ON optimization_items(job_id);
    `)
    // Additive migration for installations that already ran the discovery milestone.
    const addColumn = (table: string, name: string, definition: string) => {
      const existing = connection!.pragma(`table_info(${table})`) as { name: string }[]
      if (!existing.some(column => column.name === name)) connection!.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    }
    addColumn('optimization_jobs', 'scan_id', 'INTEGER REFERENCES scans(id)')
    addColumn('optimization_jobs', 'prefix', "TEXT NOT NULL DEFAULT ''")
    addColumn('optimization_jobs', 'min_bytes', 'INTEGER NOT NULL DEFAULT 0')
    addColumn('optimization_items', 'backup_key', 'TEXT')
    addColumn('optimization_items', 'original_sha256', 'TEXT')
    addColumn('optimization_items', 'optimized_sha256', 'TEXT')
    orm = drizzle({ client: connection, schema })
  }
  return orm
}

export function closeDatabase() {
  connection?.close()
  connection = undefined
  orm = undefined
}
