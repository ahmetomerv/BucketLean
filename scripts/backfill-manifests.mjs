import { bucketConfig } from '../shared/r2-profiles.mjs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import Database from 'better-sqlite3'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const apply = process.argv.includes('--apply')
const bucketIndex = process.argv.indexOf('--bucket-id')
const bucketId = bucketIndex >= 0 ? process.argv[bucketIndex + 1] : undefined
if (process.argv.length !== 2 + (apply ? 1 : 0) + (bucketIndex >= 0 ? 2 : 0) ||
  (bucketIndex >= 0 && !bucketId)) {
  throw new Error('Usage: node scripts/backfill-manifests.mjs [--bucket-id ID] [--apply]')
}
const profile = bucketConfig(bucketId)
const R2_BUCKET = profile.bucket
const db = new Database(process.env.DATABASE_PATH || '.data/optimizer.sqlite', { readonly: true, fileMustExist: true })
const client = new S3Client({ endpoint: profile.endpoint, region: 'auto',
  credentials: { accessKeyId: profile.accessKeyId, secretAccessKey: profile.secretAccessKey } })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const headers = head => ({ contentType: head.ContentType ?? 'image/jpeg', cacheControl: head.CacheControl ?? null,
  contentDisposition: head.ContentDisposition ?? null, contentEncoding: head.ContentEncoding ?? null,
  contentLanguage: head.ContentLanguage ?? null, expires: head.Expires?.toISOString() ?? null,
  metadata: head.Metadata ?? {} })

try {
  const identity = db.prepare('SELECT endpoint, bucket FROM bucket_profiles WHERE id = ?').get(profile.id)
  if (!identity || identity.endpoint !== profile.endpoint || identity.bucket !== profile.bucket) {
    throw new Error('SQLite bucket profile does not match the selected R2 bucket')
  }
  const rows = db.prepare(`SELECT i.id AS itemId, i.job_id AS jobId, i.key AS originalKey,
    i.etag AS originalETag, i.backup_key AS backupKey, i.original_sha256 AS sha256, i.original_size AS size
    FROM optimization_items i JOIN optimization_jobs j ON j.id = i.job_id
    WHERE j.bucket_id = ? AND i.status = 'completed' AND i.backup_key IS NOT NULL
    AND i.backup_deleted_at IS NULL
    AND i.original_sha256 IS NOT NULL ORDER BY i.id`).all(profile.id)
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
