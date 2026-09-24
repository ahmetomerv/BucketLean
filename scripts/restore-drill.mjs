import { bucketConfig } from '../shared/r2-profiles.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const apply = process.argv.includes('--apply')
const bucketIndex = process.argv.indexOf('--bucket-id')
const bucketId = bucketIndex >= 0 ? process.argv[bucketIndex + 1] : undefined
const manifestIndex = process.argv.indexOf('--manifest-key')
const manifestArgument = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : null
const expectedLength = 2 + (apply ? 1 : 0) + (manifestIndex >= 0 ? 2 : 0) + (bucketIndex >= 0 ? 2 : 0)
if (process.argv.length !== expectedLength || (manifestIndex >= 0 && !manifestArgument) || (bucketIndex >= 0 && !bucketId)) {
  throw new Error('Usage: node scripts/restore-drill.mjs [--bucket-id ID] [--manifest-key KEY] [--apply]')
}
const profile = bucketConfig(bucketId)
const R2_BUCKET = profile.bucket
const client = new S3Client({ endpoint: profile.endpoint, region: 'auto',
  credentials: { accessKeyId: profile.accessKeyId, secretAccessKey: profile.secretAccessKey } })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const headers = head => ({ contentType: head.ContentType ?? 'image/jpeg', cacheControl: head.CacheControl ?? null,
  contentDisposition: head.ContentDisposition ?? null, contentEncoding: head.ContentEncoding ?? null,
  contentLanguage: head.ContentLanguage ?? null, expires: head.Expires?.toISOString() ?? null,
  metadata: head.Metadata ?? {} })

try {
  let manifestKey = manifestArgument
  if (!manifestKey) {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET,
      Prefix: '__optimizer/manifests/', MaxKeys: 1 }))
    manifestKey = listed.Contents?.[0]?.Key
    if (!manifestKey) throw new Error('No optimizer manifest found in the bucket')
  }
  if (!manifestKey.startsWith('__optimizer/manifests/')) throw new Error('Manifest key is outside the optimizer prefix')
  const saved = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: manifestKey }))
  if (!saved.Body || (saved.ContentLength != null && saved.ContentLength > 1024 * 1024)) throw new Error('Manifest unreadable or too large')
  const manifestBytes = Buffer.from(await saved.Body.transformToByteArray())
  if (manifestBytes.length > 1024 * 1024) throw new Error('Manifest too large')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const expectedBackupKey = `__optimizer/originals/${manifestKey.slice('__optimizer/manifests/'.length).replace(/\.json$/, '')}`
  if (manifest.format !== 'r2-jpeg-optimizer-backup' || manifest.version !== 1 ||
    manifest.bucket !== R2_BUCKET || manifest.backupKey !== expectedBackupKey ||
    typeof manifest.originalKey !== 'string' || !manifest.originalKey ||
    typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 128 * 1024 * 1024 ||
    !manifest.headers || typeof manifest.headers !== 'object' ||
    typeof manifest.headers.contentType !== 'string' || !manifest.headers.metadata ||
    typeof manifest.headers.metadata !== 'object') throw new Error('Manifest fields are invalid')
  const backup = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: manifest.backupKey }))
  if (!backup.Body || (backup.ContentLength != null && backup.ContentLength > 128 * 1024 * 1024)) {
    throw new Error('Backup is missing or too large')
  }
  const bytes = Buffer.from(await backup.Body.transformToByteArray())
  if (bytes.length !== manifest.size || sha256(bytes) !== manifest.sha256) throw new Error('Backup hash or size differs from manifest')
  if (!apply) {
    console.log(JSON.stringify({ bucket: R2_BUCKET, manifestKey, originalKey: manifest.originalKey,
      backupHashVerified: true, dryRun: true }))
  } else {
    const destinationKey = `__optimizer/restore-drills/${randomUUID()}/${manifest.originalKey}`
    const originalHead = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: manifest.originalKey }))
    await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: destinationKey,
      Body: bytes, ContentLength: bytes.length, IfNoneMatch: '*',
      ContentType: manifest.headers.contentType,
      CacheControl: manifest.headers.cacheControl ?? undefined,
      ContentDisposition: manifest.headers.contentDisposition ?? undefined,
      ContentEncoding: manifest.headers.contentEncoding ?? undefined,
      ContentLanguage: manifest.headers.contentLanguage ?? undefined,
      Expires: manifest.headers.expires ? new Date(manifest.headers.expires) : undefined,
      Metadata: manifest.headers.metadata }))
    const restoredHead = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: destinationKey }))
    const restored = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: destinationKey }))
    if (!restored.Body) throw new Error('Restored object cannot be read')
    const restoredBytes = Buffer.from(await restored.Body.transformToByteArray())
    if (restoredBytes.length !== manifest.size || sha256(restoredBytes) !== manifest.sha256) {
      throw new Error('Restored object hash or size differs')
    }
    if (!isDeepStrictEqual(headers(restoredHead), manifest.headers)) {
      throw new Error('Restored object headers differ from manifest')
    }
    const originalAfter = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: manifest.originalKey }))
    if (originalHead.ETag !== originalAfter.ETag) throw new Error('Original key changed during drill')
    console.log(JSON.stringify({ bucket: R2_BUCKET, manifestKey, originalKey: manifest.originalKey,
      destinationKey, sha256: manifest.sha256, headersVerified: true, originalUntouched: true, dryRun: false }))
  }
} finally {
  client.destroy()
}
