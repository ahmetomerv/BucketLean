import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

const sourcePath = resolve(process.env.DATABASE_PATH || '.data/optimizer.sqlite')
const outputIndex = process.argv.indexOf('--output')
if (outputIndex < 0 || !process.argv[outputIndex + 1] || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/snapshot-db.mjs --output PATH')
}
const outputPath = resolve(process.argv[outputIndex + 1])
if (outputPath === sourcePath) throw new Error('Snapshot destination must differ from the live database')
if (!existsSync(sourcePath)) throw new Error(`Database does not exist: ${sourcePath}`)
if (existsSync(outputPath)) throw new Error(`Snapshot destination already exists: ${outputPath}`)
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 })
const temporaryPath = `${outputPath}.partial-${randomUUID()}`
let source
let snapshot
try {
  source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  await source.backup(temporaryPath)
  snapshot = new Database(temporaryPath, { readonly: true, fileMustExist: true })
  const integrity = snapshot.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') throw new Error(`Snapshot integrity check failed: ${integrity}`)
  const buckets = snapshot.prepare('SELECT id, endpoint, bucket FROM bucket_profiles ORDER BY id').all()
  const counts = snapshot.prepare(`SELECT
    (SELECT count(*) FROM optimization_jobs) AS jobs,
    (SELECT count(*) FROM optimization_items) AS items`).get()
  snapshot.close()
  snapshot = undefined
  chmodSync(temporaryPath, 0o600)
  linkSync(temporaryPath, outputPath) // Refuses to replace an existing snapshot.
  console.log(JSON.stringify({ output: outputPath, buckets, jobs: counts.jobs,
    items: counts.items, integrity }))
} finally {
  snapshot?.close()
  source?.close()
  if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
}
