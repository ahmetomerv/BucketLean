import { afterAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { getDatabase, closeDatabase } from './db'

const dir = mkdtempSync(join(tmpdir(), 'r2-db-test-'))
const path = join(dir, 'legacy.sqlite')
const previous = { DATABASE_PATH: process.env.DATABASE_PATH, R2_ENDPOINT: process.env.R2_ENDPOINT, R2_BUCKET: process.env.R2_BUCKET }
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('adds job columns without dropping discovery data from an earlier database', () => {
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE scans (id INTEGER PRIMARY KEY AUTOINCREMENT, prefix TEXT NOT NULL, status TEXT NOT NULL,
      discovered_count INTEGER NOT NULL DEFAULT 0, jpeg_count INTEGER NOT NULL DEFAULT 0,
      metadata_error_count INTEGER NOT NULL DEFAULT 0, cursor TEXT, error TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    INSERT INTO scans (prefix, status, discovered_count, created_at) VALUES ('photos/', 'completed', 42, '2026-09-23');
    CREATE TABLE optimization_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, preset TEXT NOT NULL,
      minimum_saving_percent INTEGER NOT NULL DEFAULT 15, backup_originals INTEGER NOT NULL DEFAULT 1,
      preserve_metadata INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE TABLE optimization_items (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL,
      key TEXT NOT NULL, etag TEXT, original_size INTEGER NOT NULL, optimized_size INTEGER,
      saved_percent INTEGER, status TEXT NOT NULL, error TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
  `)
  legacy.close()
  process.env.DATABASE_PATH = path
  process.env.R2_ENDPOINT = 'https://account.r2.cloudflarestorage.com'
  process.env.R2_BUCKET = 'original-bucket'
  expect(() => getDatabase()).toThrow('Existing database has no bucket identity')
  const bindingScript = fileURLToPath(new URL('../../scripts/bind-legacy-db.mjs', import.meta.url))
  const denied = spawnSync(process.execPath, [bindingScript, '--confirm-endpoint', 'https://account.r2.cloudflarestorage.com/',
    '--confirm-bucket', 'wrong-bucket'], { env: process.env, encoding: 'utf8' })
  expect(denied.status).not.toBe(0)
  const bound = spawnSync(process.execPath, [bindingScript, '--confirm-endpoint', 'https://account.r2.cloudflarestorage.com/',
    '--confirm-bucket', 'original-bucket'], { env: process.env, encoding: 'utf8' })
  expect(bound.status, bound.stderr).toBe(0)
  getDatabase()
  const migrated = new Database(path, { readonly: true })
  expect((migrated.prepare('SELECT discovered_count FROM scans WHERE id = 1').get() as { discovered_count: number }).discovered_count).toBe(42)
  expect((migrated.pragma('table_info(optimization_jobs)') as { name: string }[]).map(row => row.name)).toContain('scan_id')
  expect((migrated.pragma('table_info(optimization_items)') as { name: string }[]).map(row => row.name)).toContain('optimized_sha256')
  expect(migrated.prepare('SELECT endpoint, bucket FROM database_identity WHERE id = 1').get()).toEqual({
    endpoint: 'https://account.r2.cloudflarestorage.com/', bucket: 'original-bucket',
  })
  migrated.close()
  process.env.R2_BUCKET = 'different-bucket'
  expect(() => getDatabase()).toThrow('Database is bound to')
  process.env.R2_BUCKET = 'original-bucket'
})

test('binds an empty database to the configured bucket on first use', () => {
  closeDatabase()
  process.env.DATABASE_PATH = join(dir, 'fresh.sqlite')
  getDatabase()
  const db = new Database(process.env.DATABASE_PATH, { readonly: true })
  expect(db.prepare('SELECT bucket FROM database_identity WHERE id = 1').get()).toEqual({ bucket: 'original-bucket' })
  db.close()
})

test('moves legacy ambiguous failures to attention exactly once', () => {
  closeDatabase()
  const uncertainPath = join(dir, 'uncertain.sqlite')
  process.env.DATABASE_PATH = uncertainPath
  getDatabase()
  closeDatabase()
  const old = new Database(uncertainPath)
  old.exec(`
    INSERT INTO optimization_jobs (id, status, preset, created_at) VALUES (1, 'completed', 'balanced', '2026-09-23');
    INSERT INTO optimization_items (job_id, key, original_size, status, backup_key, original_sha256, optimized_sha256, created_at)
      VALUES (1, 'photo.jpg', 100, 'failed', '__optimizer/originals/1/photo.jpg', 'original', 'optimized', '2026-09-23');
    DELETE FROM app_migrations WHERE name = 'uncertain_replacements_v1';
  `)
  old.close()
  getDatabase()
  const migrated = new Database(uncertainPath, { readonly: true })
  expect(migrated.prepare('SELECT status FROM optimization_items WHERE id = 1').get()).toEqual({ status: 'needs_attention' })
  expect(migrated.prepare('SELECT status FROM optimization_jobs WHERE id = 1').get()).toEqual({ status: 'needs_attention' })
  expect((migrated.pragma('table_info(optimization_items)') as { name: string }[]).map(row => row.name))
    .toEqual(expect.arrayContaining(['backup_verified_at', 'replacement_attempted_at']))
  migrated.close()
  closeDatabase()
  const changed = new Database(uncertainPath)
  changed.exec("UPDATE optimization_items SET status = 'failed' WHERE id = 1")
  changed.close()
  getDatabase()
  const reopened = new Database(uncertainPath, { readonly: true })
  expect(reopened.prepare('SELECT status FROM optimization_items WHERE id = 1').get()).toEqual({ status: 'failed' })
  reopened.close()
})
