import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const args = process.argv.slice(2)
const valueFor = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const endpointValue = process.env.R2_ENDPOINT
const bucket = process.env.R2_BUCKET
if (!endpointValue || !bucket) throw new Error('Set R2_ENDPOINT and R2_BUCKET to the verified original bucket before binding')
const endpoint = new URL(endpointValue)
if (endpoint.protocol !== 'https:') throw new Error('R2_ENDPOINT must use HTTPS')
if (valueFor('--confirm-endpoint') !== endpoint.toString() || valueFor('--confirm-bucket') !== bucket) {
  throw new Error(`Confirm both values with --confirm-endpoint ${endpoint.toString()} --confirm-bucket ${bucket}`)
}
const path = resolve(process.env.DATABASE_PATH || '.data/optimizer.sqlite')
if (!existsSync(path)) throw new Error(`Database does not exist: ${path}`)
const db = new Database(path)
try {
  const requiredTables = ['scans', 'objects', 'optimization_jobs', 'optimization_items']
  for (const name of requiredTables) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)) {
      throw new Error(`This is not an R2 JPEG Optimizer database: missing ${name}`)
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS database_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1), endpoint TEXT NOT NULL,
    bucket TEXT NOT NULL, bound_at TEXT NOT NULL
  )`)
  const saved = db.prepare('SELECT endpoint, bucket FROM database_identity WHERE id = 1').get()
  if (saved) {
    if (saved.endpoint !== endpoint.toString() || saved.bucket !== bucket) throw new Error('Database is already bound to a different endpoint or bucket')
    console.log(`Database is already bound to ${saved.endpoint} / ${saved.bucket}`)
  } else {
    const counts = Object.fromEntries(requiredTables.map(name => [name, db.prepare(`SELECT count(*) AS count FROM ${name}`).get().count]))
    db.transaction(() => {
      db.prepare('INSERT INTO database_identity (id, endpoint, bucket, bound_at) VALUES (1, ?, ?, ?)')
        .run(endpoint.toString(), bucket, new Date().toISOString())
    }).immediate()
    console.log(`Bound ${path} to ${endpoint.toString()} / ${bucket}; existing rows: ${JSON.stringify(counts)}`)
  }
} finally { db.close() }
