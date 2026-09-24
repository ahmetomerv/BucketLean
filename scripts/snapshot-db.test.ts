import { expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'

test('creates a consistent, integrity-checked SQLite snapshot while WAL writes remain live', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-snapshot-test-'))
  const sourcePath = join(dir, 'live.sqlite')
  const outputPath = join(dir, 'snapshot.sqlite')
  const script = fileURLToPath(new URL('./snapshot-db.mjs', import.meta.url))
  const live = new Database(sourcePath)
  try {
    live.pragma('journal_mode = WAL')
    live.exec(`
      CREATE TABLE database_identity (id INTEGER PRIMARY KEY, endpoint TEXT, bucket TEXT);
      INSERT INTO database_identity VALUES (1, 'https://example.invalid/', 'test-bucket');
      CREATE TABLE optimization_jobs (id INTEGER PRIMARY KEY);
      CREATE TABLE optimization_items (id INTEGER PRIMARY KEY);
      INSERT INTO optimization_jobs VALUES (1);
      INSERT INTO optimization_items VALUES (1);
    `)
    const result = spawnSync(process.execPath, [script, '--output', outputPath], {
      env: { ...process.env, DATABASE_PATH: sourcePath }, encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ bucket: 'test-bucket', jobs: 1, items: 1, integrity: 'ok' })
    live.exec('INSERT INTO optimization_items VALUES (2)')
    const snapshot = new Database(outputPath, { readonly: true })
    expect(snapshot.prepare('SELECT count(*) AS count FROM optimization_items').get()).toEqual({ count: 1 })
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
    snapshot.close()
    const refused = spawnSync(process.execPath, [script, '--output', outputPath], {
      env: { ...process.env, DATABASE_PATH: sourcePath }, encoding: 'utf8',
    })
    expect(refused.status).not.toBe(0)
  } finally {
    live.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preserves an unbound legacy database without claiming a bucket identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-legacy-snapshot-test-'))
  const sourcePath = join(dir, 'legacy.sqlite')
  const outputPath = join(dir, 'snapshot.sqlite')
  const script = fileURLToPath(new URL('./snapshot-db.mjs', import.meta.url))
  const live = new Database(sourcePath)
  try {
    live.exec(`
      CREATE TABLE database_identity (id INTEGER PRIMARY KEY, endpoint TEXT, bucket TEXT);
      CREATE TABLE optimization_jobs (id INTEGER PRIMARY KEY);
      CREATE TABLE optimization_items (id INTEGER PRIMARY KEY);
      INSERT INTO optimization_jobs VALUES (1);
    `)
    const result = spawnSync(process.execPath, [script, '--output', outputPath], {
      env: { ...process.env, DATABASE_PATH: sourcePath }, encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ bucket: null, jobs: 1, items: 0, integrity: 'ok' })
  } finally {
    live.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
