import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { getDatabase, closeDatabase } from './db'

let dir: string
let next = 0
const previous = { DATABASE_PATH: process.env.DATABASE_PATH, R2_BUCKETS_JSON: process.env.R2_BUCKETS_JSON,
  R2_ENDPOINT: process.env.R2_ENDPOINT, R2_BUCKET: process.env.R2_BUCKET,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY }
const profiles = [
  { id: 'one', endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'photos', accessKeyId: 'account-key', secretAccessKey: 'account-secret' },
  { id: 'two', endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'media', accessKeyId: 'account-key', secretAccessKey: 'account-secret' },
  { id: 'restricted', endpoint: 'https://other.r2.cloudflarestorage.com', bucket: 'private', accessKeyId: 'bucket-key', secretAccessKey: 'bucket-secret' },
]
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'r2-db-test-'))
  for (const key of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) delete process.env[key]
  process.env.R2_BUCKETS_JSON = JSON.stringify(profiles)
})
afterEach(() => closeDatabase())
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('registers several profiles without storing credentials', () => {
  process.env.DATABASE_PATH = join(dir, `${++next}.sqlite`)
  getDatabase()
  const raw = new Database(process.env.DATABASE_PATH, { readonly: true })
  expect(raw.prepare('SELECT id, bucket FROM bucket_profiles ORDER BY id').all()).toEqual([
    { id: 'one', bucket: 'photos' }, { id: 'restricted', bucket: 'private' }, { id: 'two', bucket: 'media' },
  ])
  expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).not.toContainEqual({ name: 'database_identity' })
  raw.close()
})

test('rejects reuse of a profile ID for a different bucket', () => {
  process.env.DATABASE_PATH = join(dir, `${++next}.sqlite`)
  getDatabase()
  closeDatabase()
  process.env.R2_BUCKETS_JSON = JSON.stringify([{ ...profiles[0], bucket: 'wrong' }, ...profiles.slice(1)])
  expect(() => getDatabase()).toThrow('Bucket profile one is bound')
  process.env.R2_BUCKETS_JSON = JSON.stringify(profiles)
})

test('refuses a legacy single-bucket database until it is removed', () => {
  process.env.DATABASE_PATH = join(dir, `${++next}.sqlite`)
  const raw = new Database(process.env.DATABASE_PATH)
  raw.exec('CREATE TABLE scans (id INTEGER PRIMARY KEY, prefix TEXT NOT NULL)')
  raw.close()
  expect(() => getDatabase()).toThrow('Legacy single-bucket database is incompatible')
})

test('adds cleanup columns to an existing multi-bucket database with opt-in disabled', () => {
  process.env.DATABASE_PATH = join(dir, `${++next}.sqlite`)
  getDatabase()
  closeDatabase()
  const raw = new Database(process.env.DATABASE_PATH)
  raw.exec(`ALTER TABLE optimization_jobs DROP COLUMN delete_backup_after_optimization;
    ALTER TABLE optimization_items DROP COLUMN cleanup_pending_at;
    ALTER TABLE optimization_items DROP COLUMN backup_deleted_at;
    ALTER TABLE optimization_items DROP COLUMN manifest_deleted_at;`)
  raw.close()
  getDatabase()
  const migrated = new Database(process.env.DATABASE_PATH, { readonly: true })
  const columns = (table: string) => (migrated.pragma(`table_info(${table})`) as { name: string }[]).map(row => row.name)
  expect(columns('optimization_jobs')).toContain('delete_backup_after_optimization')
  expect(columns('optimization_items')).toEqual(expect.arrayContaining(['cleanup_pending_at', 'backup_deleted_at', 'manifest_deleted_at']))
  migrated.close()
})
