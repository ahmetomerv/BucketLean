import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  GetObjectCommand, HeadObjectCommand, PutObjectCommand,
  type HeadObjectCommandOutput, type S3Client,
} from '@aws-sdk/client-s3'
import { getDatabase } from './db'
import { optimizeImage, qualities, type Preset } from './image'
import { errorMessage, log } from './log'
import { createR2Client, r2Config } from './r2'
import { objects, optimizationItems, optimizationJobs, scans } from './schema'
import { prefixCondition } from './query'
import { workerLease, WorkerLeaseLostError } from './worker-lease'
import { classifyFailure, MAX_TRANSIENT_FAILURES, retryDelayMs, SourceChangedError } from './failures'
import { ensureBackupManifest, headersFromHead, makeBackupManifest, manifestKeyForBackup } from './backup-manifest'

const MAX_IMAGE_BYTES = 128 * 1024 * 1024
type Client = Pick<S3Client, 'send'>
type Job = typeof optimizationJobs.$inferSelect
type Item = typeof optimizationItems.$inferSelect

function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex') }
function etag(value: string | null | undefined) { return value?.replace(/^"|"$/g, '') ?? '' }
function isPreconditionFailure(error: unknown) {
  return !!error && typeof error === 'object' && ('$metadata' in error) && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412
}
function isNotFound(error: unknown) {
  return !!error && typeof error === 'object' &&
    (('$metadata' in error && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) ||
      ('name' in error && (error as { name?: string }).name === 'NoSuchKey'))
}

export function enqueueJob(input: { prefix: string, minBytes: number, preset: Preset, minimumSavingPercent: number, preserveMetadata: boolean, backupOriginals: boolean }) {
  r2Config()
  if (!input.backupOriginals) throw new Error('Original backups are required for this MVP')
  const db = getDatabase()
  const activeScan = db.select({ id: scans.id }).from(scans).where(inArray(scans.status, ['queued', 'running'])).get()
  if (activeScan) throw new Error('Wait for the current scan to finish')
  const activeJob = db.select({ id: optimizationJobs.id }).from(optimizationJobs)
    .where(inArray(optimizationJobs.status, ['queued', 'running', 'paused', 'needs_attention'])).get()
  if (activeJob) throw new Error('Resolve the existing optimization job before creating another')
  const scan = db.select().from(scans).where(eq(scans.status, 'completed')).orderBy(desc(scans.id)).get()
  if (!scan) throw new Error('Complete a scan before creating a job')
  const candidates = db.select({ key: objects.key, etag: objects.etag, size: objects.size }).from(objects).where(and(
    eq(objects.scanId, scan.id), eq(objects.isJpeg, true), eq(objects.isOptimized, false),
    eq(objects.metadataStatus, 'known'), prefixCondition(input.prefix), sql`${objects.size} >= ${input.minBytes}`,
  )).orderBy(asc(objects.key)).all()
  if (!candidates.length) throw new Error('No eligible JPEGs match the filters')
  const now = new Date().toISOString()
  const job = db.transaction((tx) => {
    const created = tx.insert(optimizationJobs).values({
      scanId: scan.id, prefix: input.prefix, minBytes: input.minBytes,
      status: 'queued', preset: input.preset, minimumSavingPercent: input.minimumSavingPercent,
      backupOriginals: true, preserveMetadata: input.preserveMetadata, createdAt: now,
    }).returning().get()
    for (const candidate of candidates) tx.insert(optimizationItems).values({
      jobId: created.id, key: candidate.key, etag: candidate.etag,
      originalSize: candidate.size, status: 'pending', createdAt: now,
    }).run()
    return created
  })
  log('info', 'job_queued', { jobId: job.id, scanId: scan.id, candidates: candidates.length })
  void runNextJob()
  return { job, count: candidates.length }
}

export function enqueueReconciliation(jobId: number) {
  r2Config()
  const db = getDatabase()
  const job = db.transaction((tx) => {
    const current = tx.select().from(optimizationJobs).where(eq(optimizationJobs.id, jobId)).get()
    if (!current) throw new Error('Job not found')
    if (current.status !== 'needs_attention') throw new Error('Job does not need reconciliation')
    if (tx.select({ id: scans.id }).from(scans).where(inArray(scans.status, ['queued', 'running'])).get()) {
      throw new Error('Wait for the current scan to finish')
    }
    if (tx.select({ id: optimizationJobs.id }).from(optimizationJobs)
      .where(inArray(optimizationJobs.status, ['queued', 'running'])).get()) {
      throw new Error('An optimization job is already active')
    }
    const items = tx.update(optimizationItems).set({ status: 'uploading', error: null, finishedAt: null })
      .where(and(eq(optimizationItems.jobId, jobId), eq(optimizationItems.status, 'needs_attention'))).returning({ id: optimizationItems.id }).all()
    if (!items.length) throw new Error('Job has no items needing reconciliation')
    tx.update(optimizationJobs).set({ status: 'queued', finishedAt: null }).where(eq(optimizationJobs.id, jobId)).run()
    return current
  })
  log('info', 'job_reconciliation_queued', { jobId, previousStatus: job.status })
  void runNextJob()
  return { jobId }
}

export function resumeJob(jobId: number) {
  r2Config()
  const db = getDatabase()
  db.transaction((tx) => {
    const job = tx.select().from(optimizationJobs).where(eq(optimizationJobs.id, jobId)).get()
    if (!job) throw new Error('Job not found')
    if (job.status !== 'paused') throw new Error('Job is not paused')
    if (tx.select({ id: scans.id }).from(scans).where(inArray(scans.status, ['queued', 'running'])).get()) {
      throw new Error('Wait for the current scan to finish')
    }
    tx.update(optimizationJobs).set({ status: 'queued', pauseReason: null })
      .where(eq(optimizationJobs.id, jobId)).run()
  })
  log('info', 'job_resumed', { jobId })
  void runNextJob()
  return { jobId }
}

export function getJobSummary(jobId: number) {
  const db = getDatabase()
  const job = db.select().from(optimizationJobs).where(eq(optimizationJobs.id, jobId)).get()
  if (!job) return null
  const counts = db.select({
    total: sql<number>`count(*)`,
    completed: sql<number>`coalesce(sum(case when ${optimizationItems.status} = 'completed' then 1 else 0 end), 0)`,
    skipped: sql<number>`coalesce(sum(case when ${optimizationItems.status} = 'skipped' then 1 else 0 end), 0)`,
    sourceChanged: sql<number>`coalesce(sum(case when ${optimizationItems.status} = 'source_changed' then 1 else 0 end), 0)`,
    invalidJpeg: sql<number>`coalesce(sum(case when ${optimizationItems.status} = 'invalid_jpeg' then 1 else 0 end), 0)`,
    failed: sql<number>`coalesce(sum(case when ${optimizationItems.status} = 'failed' then 1 else 0 end), 0)`,
    needsAttention: sql<number>`coalesce(sum(case when ${optimizationItems.status} = 'needs_attention' then 1 else 0 end), 0)`,
    unknownFinalCount: sql<number>`coalesce(sum(case when ${optimizationItems.status} in ('needs_attention', 'source_changed') or
      (${optimizationItems.replacementAttemptedAt} is not null and ${optimizationItems.status} not in ('completed', 'skipped', 'source_changed', 'invalid_jpeg', 'failed'))
      then 1 else 0 end), 0)`,
    nextRetryAt: sql<number | null>`min(case when ${optimizationItems.status} = 'retry_wait' then ${optimizationItems.nextAttemptAt} end)`,
    originalBytes: sql<number>`coalesce(sum(${optimizationItems.originalSize}), 0)`,
    calculatedFinalBytes: sql<number>`coalesce(sum(case when ${optimizationItems.status} = 'completed' then ${optimizationItems.optimizedSize} else ${optimizationItems.originalSize} end), 0)`,
  }).from(optimizationItems).where(eq(optimizationItems.jobId, jobId)).get()!
  const current = db.select({ key: optimizationItems.key, status: optimizationItems.status }).from(optimizationItems)
    .where(and(eq(optimizationItems.jobId, jobId), inArray(optimizationItems.status, ['downloading', 'processing', 'uploading']))).orderBy(asc(optimizationItems.id)).get()
  const { unknownFinalCount, calculatedFinalBytes, ...publicCounts } = counts
  const finalBytes = unknownFinalCount ? null : calculatedFinalBytes
  const savedBytes = finalBytes === null ? null : counts.originalBytes - finalBytes
  return { job, ...publicCounts, current, finalBytes, savedBytes,
    savedPercent: savedBytes === null ? null : counts.originalBytes ? Math.round(100 * savedBytes / counts.originalBytes) : 0 }
}

async function readObject(client: Client, bucket: string, key: string, ifMatch?: string) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: ifMatch }))
  if (!result.Body) throw new Error(`R2 returned an empty body for ${key}`)
  if (result.ContentLength != null && result.ContentLength > MAX_IMAGE_BYTES) throw new Error('Image exceeds 128 MiB safety limit')
  const bytes = Buffer.from(await result.Body.transformToByteArray())
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 128 MiB safety limit')
  if (result.ContentLength != null && bytes.length !== result.ContentLength) throw new Error('R2 download length mismatch')
  return { bytes, etag: result.ETag }
}

function contentHeaders(head: HeadObjectCommandOutput) {
  return {
    ContentType: head.ContentType ?? 'image/jpeg',
    CacheControl: head.CacheControl,
    ContentDisposition: head.ContentDisposition,
    ContentEncoding: head.ContentEncoding,
    ContentLanguage: head.ContentLanguage,
    Expires: head.Expires,
  }
}

async function ensureBackup(client: Client, bucket: string, key: string, original: Buffer, head: HeadObjectCommandOutput) {
  workerLease.assertOwned()
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: original, ContentLength: original.length,
      IfNoneMatch: '*', Metadata: head.Metadata, ...contentHeaders(head),
    }))
  } catch (error) {
    if (!isPreconditionFailure(error)) throw error
  }
  const backup = await readObject(client, bucket, key)
  workerLease.assertOwned()
  if (backup.bytes.length !== original.length || digest(backup.bytes) !== digest(original)) throw new Error('Backup verification failed')
  const backupHead = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  workerLease.assertOwned()
  if (!isDeepStrictEqual(headersFromHead(backupHead), headersFromHead(head))) {
    throw new Error('Backup object headers differ from the original')
  }
}

async function verifyManifest(client: Client, bucket: string, job: Job, item: Item, backupKey: string,
  originalSha256: string, originalSize: number, backupHead: HeadObjectCommandOutput) {
  workerLease.assertOwned()
  const manifest = makeBackupManifest({ bucket, jobId: job.id, itemId: item.id, originalKey: item.key,
    backupKey, originalETag: item.etag, sha256: originalSha256, size: originalSize, head: backupHead })
  const manifestKey = await ensureBackupManifest(client, bucket, manifest)
  workerLease.assertOwned()
  getDatabase().update(optimizationItems).set({ manifestKey, manifestVerifiedAt: new Date().toISOString() })
    .where(eq(optimizationItems.id, item.id)).run()
}

function markCompleted(job: Job, item: Item, optimizedSize: number, optimizedEtag: string | null) {
  workerLease.assertOwned()
  const db = getDatabase()
  const saving = Math.round(100 * (item.originalSize - optimizedSize) / item.originalSize)
  db.transaction((tx) => {
    tx.update(optimizationItems).set({ status: 'completed', optimizedSize, savedPercent: saving, error: null, finishedAt: new Date().toISOString() }).where(eq(optimizationItems.id, item.id)).run()
    tx.update(objects).set({ isOptimized: true, optimizerVersion: '1', size: optimizedSize, optimizedSize, savedPercent: saving,
      etag: optimizedEtag, metadataStatus: 'known', metadataError: null }).where(eq(objects.key, item.key)).run()
  })
  log('info', 'item_completed', { jobId: job.id, itemId: item.id, key: item.key, originalSize: item.originalSize, optimizedSize })
}

async function reconcileRemoteState(client: Client, bucket: string, job: Job, item: Item, head: HeadObjectCommandOutput) {
  if (!item.backupKey || !item.originalSha256 || !item.optimizedSha256) {
    throw new Error('Persisted upload intent is incomplete; inspect source and backup manually')
  }
  workerLease.assertOwned()
  const source = await readObject(client, bucket, item.key, head.ETag)
  workerLease.assertOwned()
  const sourceHash = digest(source.bytes)
  let backupMissing = false
  let backup: Awaited<ReturnType<typeof readObject>> | undefined
  try { backup = await readObject(client, bucket, item.backupKey) }
  catch (error) {
    if (isNotFound(error)) backupMissing = true
    else throw error
  }
  workerLease.assertOwned()
  if (backup && digest(backup.bytes) !== item.originalSha256) throw new Error('Backup hash differs from the recorded original')
  if (backup && !item.backupVerifiedAt) {
    getDatabase().update(optimizationItems).set({ backupVerifiedAt: new Date().toISOString() })
      .where(eq(optimizationItems.id, item.id)).run()
  }
  const ownUpload = head.Metadata?.['image-optimizer-version'] === '1' &&
    head.Metadata?.['image-optimizer-job-id'] === String(job.id) &&
    head.Metadata?.['image-optimizer-item-id'] === String(item.id)
  if (sourceHash === item.optimizedSha256 && ownUpload) {
    if (backupMissing) throw new Error('Optimized source is present, but its original backup is missing')
    const backupHead = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: item.backupKey }))
    await verifyManifest(client, bucket, job, item, item.backupKey, item.originalSha256, item.originalSize, backupHead)
    markCompleted(job, item, source.bytes.length, head.ETag ?? null)
    return 'completed' as const
  }
  if (sourceHash === item.originalSha256 && etag(head.ETag) === etag(item.etag) &&
    source.bytes.length === item.originalSize && !head.Metadata?.['image-optimizer-version']) {
    if (backupMissing && item.backupVerifiedAt) getDatabase().update(optimizationItems)
      .set({ backupVerifiedAt: null }).where(eq(optimizationItems.id, item.id)).run()
    return 'original' as const
  }
  throw new SourceChangedError('Source differs from the recorded original and verified replacement; inspect both objects')
}

async function processItem(client: Client, bucket: string, job: Job, item: Item) {
  const db = getDatabase()
  workerLease.assertOwned()
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: item.key }))
  workerLease.assertOwned()
  if (item.status === 'uploading' || item.backupKey || item.replacementAttemptedAt) {
    if (await reconcileRemoteState(client, bucket, job, item, head) === 'completed') return
  }
  if (head.Metadata?.['image-optimizer-version']) {
    db.update(optimizationItems).set({ status: 'skipped', error: 'Already optimized by another job', finishedAt: new Date().toISOString() }).where(eq(optimizationItems.id, item.id)).run()
    return
  }
  if (!item.etag || etag(head.ETag) !== etag(item.etag) || head.ContentLength !== item.originalSize) {
    db.update(optimizationItems).set({ status: 'source_changed', errorKind: 'source_changed',
      error: 'Object changed since the scan', finishedAt: new Date().toISOString() }).where(eq(optimizationItems.id, item.id)).run()
    return
  }
  if (item.originalSize > MAX_IMAGE_BYTES) {
    db.update(optimizationItems).set({ status: 'skipped', error: 'Image exceeds 128 MiB safety limit', finishedAt: new Date().toISOString() }).where(eq(optimizationItems.id, item.id)).run()
    return
  }
  db.update(optimizationItems).set({ status: 'downloading', startedAt: item.startedAt ?? new Date().toISOString(), error: null }).where(eq(optimizationItems.id, item.id)).run()
  const downloaded = await readObject(client, bucket, item.key, item.etag)
  workerLease.assertOwned()
  if (etag(downloaded.etag) !== etag(item.etag) || downloaded.bytes.length !== item.originalSize) throw new SourceChangedError('Original changed during download')
  db.update(optimizationItems).set({ status: 'processing' }).where(eq(optimizationItems.id, item.id)).run()
  const { output } = await optimizeImage(downloaded.bytes, job.preset as Preset, job.preserveMetadata)
  workerLease.assertOwned()
  const savedPercent = Math.round(100 * (downloaded.bytes.length - output.length) / downloaded.bytes.length)
  if (output.length > downloaded.bytes.length * (1 - job.minimumSavingPercent / 100)) {
    db.update(optimizationItems).set({ status: 'skipped', optimizedSize: output.length, savedPercent,
      error: 'Saving below threshold', finishedAt: new Date().toISOString() }).where(eq(optimizationItems.id, item.id)).run()
    log('info', 'item_skipped', { jobId: job.id, itemId: item.id, reason: 'saving_below_threshold' })
    return
  }
  const backupKey = `__optimizer/originals/${job.id}/${createHash('sha256').update(item.key).digest('hex')}.jpg`
  const manifestKey = manifestKeyForBackup(backupKey)
  const originalSha256 = digest(downloaded.bytes)
  const optimizedSha256 = digest(output)
  db.update(optimizationItems).set({ status: 'uploading', backupKey, manifestKey, originalSha256, optimizedSha256,
    optimizedSize: output.length, savedPercent, backupVerifiedAt: null, manifestVerifiedAt: null }).where(eq(optimizationItems.id, item.id)).run()
  await ensureBackup(client, bucket, backupKey, downloaded.bytes, head)
  workerLease.assertOwned()
  const backupVerifiedAt = new Date().toISOString()
  db.update(optimizationItems).set({ backupVerifiedAt }).where(eq(optimizationItems.id, item.id)).run()
  await verifyManifest(client, bucket, job, item, backupKey, originalSha256, downloaded.bytes.length, head)
  const metadata = {
    ...head.Metadata,
    'image-optimizer-version': '1',
    'image-optimizer-quality': String(qualities[job.preset as Preset]),
    'image-optimizer-date': new Date().toISOString(),
    'image-optimizer-job-id': String(job.id),
    'image-optimizer-item-id': String(item.id),
    'original-size': String(downloaded.bytes.length),
  }
  const replacementAttemptedAt = item.replacementAttemptedAt ?? new Date().toISOString()
  db.update(optimizationItems).set({ replacementAttemptedAt }).where(eq(optimizationItems.id, item.id)).run()
  workerLease.assertOwned()
  let putError: unknown
  try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: item.key, Body: output, ContentLength: output.length,
    IfMatch: item.etag, Metadata: metadata, ...contentHeaders(head) })) }
  catch (error) { putError = error }
  workerLease.assertOwned()
  const verified = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: item.key }))
  const intent = { ...item, backupKey, originalSha256, optimizedSha256, optimizedSize: output.length,
    backupVerifiedAt, replacementAttemptedAt }
  const outcome = await reconcileRemoteState(client, bucket, job, intent, verified)
  if (outcome === 'completed') return
  const cause = putError ? isPreconditionFailure(putError) ? 'Conditional replacement was rejected' : errorMessage(putError)
    : 'Replacement returned success'
  if (putError && isPreconditionFailure(putError)) throw new SourceChangedError(`${cause}; the original is still present. Recheck the job before retrying`)
  throw new Error(`${cause}; the original is still present. Recheck the job to retry safely`, { cause: putError })
}

let stopping = false
let active: Promise<void> | undefined

export function runNextJob() {
  if (stopping || active) return active
  const db = getDatabase()
  const job = db.select().from(optimizationJobs).where(inArray(optimizationJobs.status, ['queued', 'running'])).orderBy(asc(optimizationJobs.id)).get()
  if (!job) return
  const unfinished = db.select({ id: optimizationItems.id }).from(optimizationItems)
    .where(and(eq(optimizationItems.jobId, job.id), inArray(optimizationItems.status,
      ['pending', 'downloading', 'processing', 'uploading', 'retry_wait']))).get()
  const runnable = db.select({ id: optimizationItems.id }).from(optimizationItems).where(and(eq(optimizationItems.jobId, job.id),
    sql`(${optimizationItems.status} in ('pending', 'downloading', 'processing', 'uploading') or
      (${optimizationItems.status} = 'retry_wait' and (${optimizationItems.nextAttemptAt} is null or ${optimizationItems.nextAttemptAt} <= ${Date.now()})))`)).get()
  if (unfinished && !runnable) return
  try { if (!workerLease.tryAcquire()) return }
  catch (error) {
    log('error', 'job_lease_claim_failed', { error: errorMessage(error) })
    return
  }
  active = runJob(job).catch(error => log('error', 'job_worker_failed', { jobId: job.id, error: errorMessage(error) })).finally(() => { active = undefined })
  return active
}

async function runJob(job: Job) {
  const db = getDatabase()
  let client: ReturnType<typeof createR2Client> | undefined
  try {
    const config = r2Config()
    client = createR2Client(config)
    workerLease.assertOwned()
    db.update(optimizationJobs).set({ status: 'running', startedAt: job.startedAt ?? new Date().toISOString() }).where(eq(optimizationJobs.id, job.id)).run()
    log('info', 'job_started', { jobId: job.id })
    let paused = false
    while (!stopping) {
      workerLease.assertOwned()
      const item = db.select().from(optimizationItems).where(and(eq(optimizationItems.jobId, job.id),
        sql`(${optimizationItems.status} in ('pending', 'downloading', 'processing', 'uploading') or
          (${optimizationItems.status} = 'retry_wait' and (${optimizationItems.nextAttemptAt} is null or ${optimizationItems.nextAttemptAt} <= ${Date.now()})))`))
        .orderBy(asc(optimizationItems.id)).get()
      if (!item) break
      db.update(optimizationItems).set({ attemptCount: item.attemptCount + 1, nextAttemptAt: null,
        error: null, errorKind: null }).where(eq(optimizationItems.id, item.id)).run()
      try { await processItem(client, config.bucket, job, item) }
      catch (error) {
        if (error instanceof WorkerLeaseLostError) throw error
        workerLease.assertOwned()
        const message = errorMessage(error)
        const kind = classifyFailure(error)
        const latest = db.select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()!
        const uncertain = latest.status === 'uploading' || !!latest.backupKey || !!latest.replacementAttemptedAt
        if (kind === 'credentials' || kind === 'bucket') {
          db.transaction((tx) => {
            tx.update(optimizationItems).set({ status: latest.status === 'retry_wait' ? (uncertain ? 'uploading' : 'pending') : latest.status,
              error: message, errorKind: kind }).where(eq(optimizationItems.id, item.id)).run()
            tx.update(optimizationJobs).set({ status: 'paused', pauseReason: `${kind}: ${message}` })
              .where(eq(optimizationJobs.id, job.id)).run()
          })
          log('error', 'job_paused', { jobId: job.id, itemId: item.id, key: item.key, kind, error: message })
          paused = true
          break
        }
        if (kind === 'transient' || kind === 'throttled') {
          const failures = latest.transientFailures + 1
          if (failures < MAX_TRANSIENT_FAILURES) {
            const nextAttemptAt = Date.now() + retryDelayMs(failures)
            db.update(optimizationItems).set({ status: 'retry_wait', transientFailures: failures,
              nextAttemptAt, error: message, errorKind: kind }).where(eq(optimizationItems.id, item.id)).run()
            log('info', 'item_retry_scheduled', { jobId: job.id, itemId: item.id, key: item.key,
              kind, failures, nextAttemptAt })
            continue
          }
          db.update(optimizationItems).set({ transientFailures: failures }).where(eq(optimizationItems.id, item.id)).run()
        }
        const status = uncertain ? 'needs_attention'
          : kind === 'source_changed' ? 'source_changed'
            : kind === 'invalid_jpeg' ? 'invalid_jpeg' : 'failed'
        db.update(optimizationItems).set({ status, error: message, errorKind: kind,
          finishedAt: new Date().toISOString() }).where(eq(optimizationItems.id, item.id)).run()
        log('error', status === 'needs_attention' ? 'item_needs_attention'
          : status === 'source_changed' ? 'item_source_changed'
            : status === 'invalid_jpeg' ? 'item_invalid_jpeg' : 'item_failed',
          { jobId: job.id, itemId: item.id, key: item.key, kind, error: message })
      }
    }
    if (!stopping && !paused) {
      workerLease.assertOwned()
      const unfinished = db.select({ id: optimizationItems.id }).from(optimizationItems)
        .where(and(eq(optimizationItems.jobId, job.id), inArray(optimizationItems.status,
          ['pending', 'downloading', 'processing', 'uploading', 'retry_wait']))).get()
      if (unfinished) return
      const needsAttention = db.select({ id: optimizationItems.id }).from(optimizationItems)
        .where(and(eq(optimizationItems.jobId, job.id), eq(optimizationItems.status, 'needs_attention'))).get()
      const errors = db.select({ id: optimizationItems.id }).from(optimizationItems)
        .where(and(eq(optimizationItems.jobId, job.id), inArray(optimizationItems.status, ['failed', 'invalid_jpeg']))).get()
      const status = needsAttention ? 'needs_attention' : errors ? 'completed_with_errors' : 'completed'
      db.update(optimizationJobs).set({ status, finishedAt: new Date().toISOString() }).where(eq(optimizationJobs.id, job.id)).run()
      log('info', status === 'completed' ? 'job_completed'
        : status === 'completed_with_errors' ? 'job_completed_with_errors' : 'job_needs_attention', { jobId: job.id })
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'R2 connection is not configured') {
      db.update(optimizationJobs).set({ status: 'paused', pauseReason: `credentials: ${error.message}` })
        .where(eq(optimizationJobs.id, job.id)).run()
      log('error', 'job_paused', { jobId: job.id, kind: 'credentials', error: error.message })
      return
    }
    throw error
  } finally { client?.destroy() }
}

export async function stopJobWorker() {
  stopping = true
  await active
}
