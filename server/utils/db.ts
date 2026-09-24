import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

let connection: Database.Database | undefined
let orm: ReturnType<typeof drizzle<typeof schema>> | undefined

function configuredBucketIdentity() {
  const endpoint = process.env.R2_ENDPOINT
  const bucket = process.env.R2_BUCKET
  if (!endpoint && !bucket) return null
  if (!endpoint || !bucket) throw new Error('R2_ENDPOINT and R2_BUCKET must both be set for this database')
  const url = new URL(endpoint)
  if (url.protocol !== 'https:') throw new Error('R2_ENDPOINT must use HTTPS')
  return { endpoint: url.toString(), bucket }
}

function assertBucketIdentity(db: Database.Database) {
  const configured = configuredBucketIdentity()
  const saved = db.prepare('SELECT endpoint, bucket FROM database_identity WHERE id = 1').get() as { endpoint: string, bucket: string } | undefined
  if (saved) {
    if (!configured || saved.endpoint !== configured.endpoint || saved.bucket !== configured.bucket) {
      throw new Error(`Database is bound to ${saved.endpoint} / ${saved.bucket}; configured R2 endpoint or bucket differs`)
    }
    return
  }
  const populated = db.prepare(`SELECT
    EXISTS(SELECT 1 FROM scans) OR EXISTS(SELECT 1 FROM objects) OR
    EXISTS(SELECT 1 FROM optimization_jobs) OR EXISTS(SELECT 1 FROM optimization_items) AS has_data`).get() as { has_data: number }
  if (populated.has_data) {
    throw new Error('Existing database has no bucket identity. Verify its bucket, then run the legacy database binding command before starting the app')
  }
  if (configured) {
    db.prepare('INSERT OR IGNORE INTO database_identity (id, endpoint, bucket, bound_at) VALUES (1, ?, ?, ?)')
      .run(configured.endpoint, configured.bucket, new Date().toISOString())
    const bound = db.prepare('SELECT endpoint, bucket FROM database_identity WHERE id = 1').get() as { endpoint: string, bucket: string }
    if (bound.endpoint !== configured.endpoint || bound.bucket !== configured.bucket) {
      throw new Error(`Database is bound to ${bound.endpoint} / ${bound.bucket}; configured R2 endpoint or bucket differs`)
    }
  }
}

export function getDatabase() {
  if (!orm) {
    const path = resolve(process.env.DATABASE_PATH || '.data/optimizer.sqlite')
    mkdirSync(dirname(path), { recursive: true })
    connection = new Database(path)
    try {
      const journalMode = connection.pragma('journal_mode = WAL', { simple: true })
      if (journalMode !== 'wal') throw new Error('SQLite WAL mode could not be enabled; use a local persistent volume')
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
      CREATE TABLE IF NOT EXISTS database_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1), endpoint TEXT NOT NULL,
        bucket TEXT NOT NULL, bound_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_lease (
        name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
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
      addColumn('optimization_items', 'manifest_key', 'TEXT')
      addColumn('optimization_items', 'original_sha256', 'TEXT')
      addColumn('optimization_items', 'optimized_sha256', 'TEXT')
      addColumn('optimization_items', 'backup_verified_at', 'TEXT')
      addColumn('optimization_items', 'manifest_verified_at', 'TEXT')
      addColumn('optimization_items', 'replacement_attempted_at', 'TEXT')
      addColumn('optimization_jobs', 'pause_reason', 'TEXT')
      addColumn('optimization_items', 'error_kind', 'TEXT')
      addColumn('optimization_items', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0')
      addColumn('optimization_items', 'transient_failures', 'INTEGER NOT NULL DEFAULT 0')
      addColumn('optimization_items', 'next_attempt_at', 'INTEGER')
      connection.exec('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
      if (!connection.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get('uncertain_replacements_v1')) {
        connection.transaction(() => {
          // Older workers could mark a successful but unverified replacement as failed.
          connection!.exec(`UPDATE optimization_items SET status = 'needs_attention'
            WHERE status = 'failed' AND backup_key IS NOT NULL AND original_sha256 IS NOT NULL AND optimized_sha256 IS NOT NULL`)
          connection!.exec(`UPDATE optimization_jobs SET status = 'needs_attention'
            WHERE status = 'completed' AND EXISTS (
              SELECT 1 FROM optimization_items WHERE job_id = optimization_jobs.id AND status = 'needs_attention'
            )`)
          connection!.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
            .run('uncertain_replacements_v1', new Date().toISOString())
        }).immediate()
      }
      if (!connection.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get('job_error_status_v1')) {
        connection.transaction(() => {
          connection!.exec(`UPDATE optimization_jobs SET status = 'completed_with_errors'
            WHERE status = 'completed' AND EXISTS (
              SELECT 1 FROM optimization_items WHERE job_id = optimization_jobs.id AND status IN ('failed', 'invalid_jpeg')
            )`)
          connection!.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
            .run('job_error_status_v1', new Date().toISOString())
        }).immediate()
      }
      assertBucketIdentity(connection)
      orm = drizzle({ client: connection, schema })
    } catch (error) {
      connection.close()
      connection = undefined
      throw error
    }
  }
  assertBucketIdentity(connection!)
  return orm
}

export function getDatabaseConnection() {
  getDatabase()
  return connection!
}

export function closeDatabase() {
  connection?.close()
  connection = undefined
  orm = undefined
}
