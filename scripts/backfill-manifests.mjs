import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import Database from 'better-sqlite3'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const apply = process.argv.includes('--apply')
const verifyLegacy = process.argv.includes('--verify-unbound')
if (process.argv.length !== 2 + (apply ? 1 : 0) + (verifyLegacy ? 1 : 0) || (apply && verifyLegacy)) {
  throw new Error('Usage: node scripts/backfill-manifests.mjs [--apply | --verify-unbound]')
}
const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env
if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) throw new Error('R2 configuration is incomplete')
const endpoint = new URL(R2_ENDPOINT)
if (endpoint.protocol !== 'https:') throw new Error('R2 endpoint must use HTTPS')
const db = new Database(process.env.DATABASE_PATH || '.data/optimizer.sqlite', { readonly: true, fileMustExist: true })
const client = new S3Client({ endpoint: endpoint.toString(), region: 'auto',
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const headers = head => ({ contentType: head.ContentType ?? 'image/jpeg', cacheControl: head.CacheControl ?? null,
  contentDisposition: head.ContentDisposition ?? null, contentEncoding: head.ContentEncoding ?? null,
  contentLanguage: head.ContentLanguage ?? null, expires: head.Expires?.toISOString() ?? null,
  metadata: head.Metadata ?? {} })

try {
  const identity = db.prepare('SELECT endpoint, bucket FROM database_identity WHERE id = 1').get()
  if ((!identity && !verifyLegacy) || (identity &&
    (identity.endpoint !== endpoint.toString() || identity.bucket !== R2_BUCKET))) {
    throw new Error('SQLite bucket identity does not match the configured R2 bucket')
  }
  const rows = db.prepare(`SELECT i.id AS itemId, i.job_id AS jobId, i.key AS originalKey,
    i.etag AS originalETag, i.backup_key AS backupKey, i.original_sha256 AS sha256, i.original_size AS size
    FROM optimization_items i WHERE i.status = 'completed' AND i.backup_key IS NOT NULL
    AND i.original_sha256 IS NOT NULL ORDER BY i.id`).all()
  let verified = 0
  let written = 0
  for (const row of rows) {
    if (!row.backupKey.startsWith('__optimizer/originals/')) throw new Error('Invalid optimizer backup key')
    const manifestKey = `__optimizer/manifests/${row.backupKey.slice('__optimizer/originals/'.length)}.json`
    const backup = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: row.backupKey }))
    if (!backup.Body || (backup.ContentLength != null && backup.ContentLength > 128 * 1024 * 1024)) {
      throw new Error(`Backup missing or too large for item ${row.itemId}`)
    }
    const bytes = Buffer.from(await backup.Body.transformToByteArray())
    if (bytes.length !== row.size || sha256(bytes) !== row.sha256) {
      throw new Error(`Backup hash or size differs for item ${row.itemId}`)
    }
    const head = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: row.backupKey }))
    const expected = { format: 'r2-jpeg-optimizer-backup', version: 1, bucket: R2_BUCKET,
      jobId: row.jobId, itemId: row.itemId, originalKey: row.originalKey, backupKey: row.backupKey,
      originalETag: row.originalETag, sha256: row.sha256, size: row.size,
      headers: headers(head), createdAt: new Date().toISOString() }
    if (apply) {
      const body = Buffer.from(JSON.stringify(expected))
      try {
        await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: manifestKey,
          Body: body, ContentLength: body.length, ContentType: 'application/json', IfNoneMatch: '*' }))
        written++
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 412) throw error
      }
      const saved = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: manifestKey }))
      if (!saved.Body || (saved.ContentLength != null && saved.ContentLength > 1024 * 1024)) throw new Error('Manifest unreadable')
      const savedBytes = Buffer.from(await saved.Body.transformToByteArray())
      if (savedBytes.length > 1024 * 1024) throw new Error('Manifest too large')
      const parsed = JSON.parse(savedBytes.toString('utf8'))
      const { createdAt: _actualCreatedAt, ...actualStable } = parsed
      const { createdAt: _expectedCreatedAt, ...expectedStable } = expected
      if (!isDeepStrictEqual(actualStable, expectedStable)) throw new Error(`Manifest differs for item ${row.itemId}`)
    }
    verified++
  }
  console.log(JSON.stringify({ bucket: R2_BUCKET, checkedBackups: verified, manifestsWritten: written, dryRun: !apply }))
} finally {
  client.destroy()
  db.close()
}
