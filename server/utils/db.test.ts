import { afterAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { getDatabase, closeDatabase } from './db'

const dir = mkdtempSync(join(tmpdir(), 'r2-db-test-'))
const path = join(dir, 'legacy.sqlite')
afterAll(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); delete process.env.DATABASE_PATH })

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
  getDatabase()
  const migrated = new Database(path, { readonly: true })
  expect((migrated.prepare('SELECT discovered_count FROM scans WHERE id = 1').get() as { discovered_count: number }).discovered_count).toBe(42)
  expect((migrated.pragma('table_info(optimization_jobs)') as { name: string }[]).map(row => row.name)).toContain('scan_id')
  expect((migrated.pragma('table_info(optimization_items)') as { name: string }[]).map(row => row.name)).toContain('optimized_sha256')
  migrated.close()
})
