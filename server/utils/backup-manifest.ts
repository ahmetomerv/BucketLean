import { isDeepStrictEqual } from 'node:util'
import { GetObjectCommand, PutObjectCommand, type HeadObjectCommandOutput, type S3Client } from '@aws-sdk/client-s3'

export type RestoreHeaders = {
  contentType: string
  cacheControl: string | null
  contentDisposition: string | null
  contentEncoding: string | null
  contentLanguage: string | null
  expires: string | null
  metadata: Record<string, string>
}

export type BackupManifest = {
  format: 'r2-jpeg-optimizer-backup'
  version: 1
  bucket: string
  jobId: number
  itemId: number
  originalKey: string
  backupKey: string
  originalETag: string | null
  sha256: string
  size: number
  headers: RestoreHeaders
  createdAt: string
}

export function manifestKeyForBackup(backupKey: string) {
  const prefix = '__optimizer/originals/'
  if (!backupKey.startsWith(prefix)) throw new Error('Invalid optimizer backup key')
  return `__optimizer/manifests/${backupKey.slice(prefix.length)}.json`
}

export function headersFromHead(head: HeadObjectCommandOutput): RestoreHeaders {
  return {
    contentType: head.ContentType ?? 'image/jpeg',
    cacheControl: head.CacheControl ?? null,
    contentDisposition: head.ContentDisposition ?? null,
    contentEncoding: head.ContentEncoding ?? null,
    contentLanguage: head.ContentLanguage ?? null,
    expires: head.Expires?.toISOString() ?? null,
    metadata: head.Metadata ?? {},
  }
}

export function makeBackupManifest(input: Omit<BackupManifest, 'format' | 'version' | 'createdAt' | 'headers'> &
  { head: HeadObjectCommandOutput }): BackupManifest {
  const { head, ...rest } = input
  return { format: 'r2-jpeg-optimizer-backup', version: 1, ...rest,
    headers: headersFromHead(head), createdAt: new Date().toISOString() }
}

export function assertManifestMatches(actual: unknown, expected: BackupManifest) {
  if (!actual || typeof actual !== 'object') throw new Error('Backup manifest is invalid')
  const manifest = actual as BackupManifest
  const { createdAt: _actualCreatedAt, ...actualStable } = manifest
  const { createdAt: _expectedCreatedAt, ...expectedStable } = expected
  if (!isDeepStrictEqual(actualStable, expectedStable) || typeof manifest.createdAt !== 'string') {
    throw new Error('Backup manifest differs from the verified original')
  }
}

export async function ensureBackupManifest(client: Pick<S3Client, 'send'>, bucket: string, manifest: BackupManifest) {
  const key = manifestKeyForBackup(manifest.backupKey)
  const bytes = Buffer.from(JSON.stringify(manifest))
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes,
      ContentLength: bytes.length, ContentType: 'application/json', IfNoneMatch: '*' }))
  } catch (error) {
    const status = error && typeof error === 'object' && '$metadata' in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined
    if (status !== 412) throw error
  }
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!result.Body || (result.ContentLength != null && result.ContentLength > 1024 * 1024)) {
    throw new Error('Backup manifest is missing or too large')
  }
  const saved = Buffer.from(await result.Body.transformToByteArray())
  if (saved.length > 1024 * 1024 || (result.ContentLength != null && saved.length !== result.ContentLength)) {
    throw new Error('Backup manifest length is invalid')
  }
  let parsed: unknown
  try { parsed = JSON.parse(saved.toString('utf8')) }
  catch { throw new Error('Backup manifest JSON is invalid') }
  assertManifestMatches(parsed, manifest)
  return key
}
