import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { configuredBuckets } from '../../shared/r2-profiles.mjs'
import * as schema from './schema'

let connection: Database.Database | undefined
let orm: ReturnType<typeof drizzle<typeof schema>> | undefined
let profileIdentity: string | undefined

function configuredIdentity() {
  return configuredBuckets().map(({ id, endpoint, bucket }) => `${id}\n${endpoint}\n${bucket}`).sort().join('\n---\n')
}

function syncProfiles(db: Database.Database) {
  db.transaction(() => {
    for (const profile of configuredBuckets()) {
      const saved = db.prepare('SELECT endpoint, bucket FROM bucket_profiles WHERE id = ?').get(profile.id) as
        { endpoint: string, bucket: string } | undefined
      if (saved && (saved.endpoint !== profile.endpoint || saved.bucket !== profile.bucket)) {
        throw new Error(`Bucket profile ${profile.id} is bound to ${saved.endpoint} / ${saved.bucket}; use a new profile ID`)
      }
      const duplicate = db.prepare('SELECT id FROM bucket_profiles WHERE endpoint = ? AND bucket = ?').get(
        profile.endpoint, profile.bucket) as { id: string } | undefined
      if (duplicate && duplicate.id !== profile.id) throw new Error(`Bucket is already registered as ${duplicate.id}`)
      db.prepare('INSERT OR IGNORE INTO bucket_profiles (id, endpoint, bucket, created_at) VALUES (?, ?, ?, ?)')
        .run(profile.id, profile.endpoint, profile.bucket, new Date().toISOString())
    }
  }).immediate()
}

export function getDatabase() {
  const identity = configuredIdentity()
  if (orm) {
    if (identity !== profileIdentity) throw new Error('R2 bucket profiles changed; restart the app before continuing')
    return orm
  }
  const path = resolve(process.env.DATABASE_PATH || '.data/optimizer.sqlite')
  mkdirSync(dirname(path), { recursive: true })
  connection = new Database(path)
  try {
    const journalMode = connection.pragma('journal_mode = WAL', { simple: true })
    if (journalMode !== 'wal') throw new Error('SQLite WAL mode could not be enabled; use a local persistent volume')
    connection.pragma('foreign_keys = ON')
    const existingScans = connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scans'").get()
    if (existingScans && !(connection.pragma('table_info(scans)') as { name: string }[]).some(row => row.name === 'bucket_id')) {
      throw new Error('Legacy single-bucket database is incompatible; archive or remove it before using multi-bucket mode')
    }
    connection.exec(`
      CREATE TABLE IF NOT EXISTS bucket_profiles (
        id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, bucket TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(endpoint, bucket)
      );
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket_id TEXT NOT NULL REFERENCES bucket_profiles(id),
        prefix TEXT NOT NULL, status TEXT NOT NULL,
        discovered_count INTEGER NOT NULL DEFAULT 0, jpeg_count INTEGER NOT NULL DEFAULT 0,
        metadata_error_count INTEGER NOT NULL DEFAULT 0, cursor TEXT, error TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS scans_bucket_id_idx ON scans(bucket_id, id);
      CREATE TABLE IF NOT EXISTS objects (
        bucket_id TEXT NOT NULL REFERENCES bucket_profiles(id), key TEXT NOT NULL,
        scan_id INTEGER NOT NULL REFERENCES scans(id), etag TEXT, size INTEGER NOT NULL,
        last_modified TEXT, is_jpeg INTEGER NOT NULL, is_optimized INTEGER,
        metadata_status TEXT NOT NULL, metadata_error TEXT, optimizer_version TEXT,
        optimized_size INTEGER, saved_percent INTEGER, discovered_at TEXT NOT NULL,
        PRIMARY KEY(bucket_id, key)
      );
      CREATE INDEX IF NOT EXISTS objects_scan_id_idx ON objects(scan_id);
      CREATE TABLE IF NOT EXISTS optimization_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket_id TEXT NOT NULL REFERENCES bucket_profiles(id),
        scan_id INTEGER REFERENCES scans(id), prefix TEXT NOT NULL DEFAULT '',
        min_bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, preset TEXT NOT NULL,
        minimum_saving_percent INTEGER NOT NULL DEFAULT 15,
        backup_originals INTEGER NOT NULL DEFAULT 1, preserve_metadata INTEGER NOT NULL DEFAULT 1,
        delete_backup_after_optimization INTEGER NOT NULL DEFAULT 0,
        pause_reason TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS optimization_jobs_bucket_id_idx ON optimization_jobs(bucket_id, id);
      CREATE TABLE IF NOT EXISTS optimization_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES optimization_jobs(id), key TEXT NOT NULL,
        etag TEXT, original_size INTEGER NOT NULL, optimized_size INTEGER,
        saved_percent INTEGER, status TEXT NOT NULL, error TEXT, error_kind TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, transient_failures INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER, backup_key TEXT, manifest_key TEXT,
        original_sha256 TEXT, optimized_sha256 TEXT, backup_verified_at TEXT,
        manifest_verified_at TEXT, replacement_attempted_at TEXT,
        cleanup_pending_at TEXT, backup_deleted_at TEXT, manifest_deleted_at TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS optimization_items_job_id_idx ON optimization_items(job_id);
      CREATE TABLE IF NOT EXISTS worker_lease (
        name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `)
    const jobColumns = new Set((connection.pragma('table_info(optimization_jobs)') as { name: string }[]).map(row => row.name))
    if (!jobColumns.has('delete_backup_after_optimization')) {
      connection.exec('ALTER TABLE optimization_jobs ADD COLUMN delete_backup_after_optimization INTEGER NOT NULL DEFAULT 0')
    }
    const itemColumns = new Set((connection.pragma('table_info(optimization_items)') as { name: string }[]).map(row => row.name))
    for (const column of ['cleanup_pending_at', 'backup_deleted_at', 'manifest_deleted_at']) {
      if (!itemColumns.has(column)) connection.exec(`ALTER TABLE optimization_items ADD COLUMN ${column} TEXT`)
    }
    syncProfiles(connection)
    orm = drizzle({ client: connection, schema })
    profileIdentity = identity
    return orm
  } catch (error) {
    connection.close()
    connection = undefined
    throw error
  }
}

export function getDatabaseConnection() {
  getDatabase()
  return connection!
}

export function closeDatabase() {
  connection?.close()
  connection = undefined
  orm = undefined
  profileIdentity = undefined
}
