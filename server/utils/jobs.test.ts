import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

const { send, compress, configFailure, manifestStore, manifestRequest } = vi.hoisted(() => ({
  send: vi.fn(), compress: vi.fn(), configFailure: vi.fn(), manifestStore: new Map<string, Buffer>(), manifestRequest: vi.fn(),
}))
vi.mock('./r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./r2')>()
  const { GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3')
  const { Readable } = await import('node:stream')
  return { ...actual,
    r2Config: () => {
      const error = configFailure()
      if (error) throw error
      return { endpoint: 'https://example.r2.cloudflarestorage.com', bucket: 'test', accessKeyId: 'x', secretAccessKey: 'x' }
    },
    createR2Client: () => ({ send: async (command: unknown) => {
      if (command instanceof PutObjectCommand && command.input.Key?.startsWith('__optimizer/manifests/')) {
        manifestRequest(command)
        if (manifestStore.has(command.input.Key)) throw { $metadata: { httpStatusCode: 412 } }
        manifestStore.set(command.input.Key, Buffer.from(command.input.Body as Buffer))
        return {}
      }
      if (command instanceof GetObjectCommand && command.input.Key?.startsWith('__optimizer/manifests/')) {
        manifestRequest(command)
        const bytes = manifestStore.get(command.input.Key)
        if (!bytes) throw { $metadata: { httpStatusCode: 404 } }
        return { ContentLength: bytes.length, Body: { transformToByteArray: async () => bytes } }
      }
      const result = await send(command)
      if (command instanceof GetObjectCommand && result?.Body && !(Symbol.asyncIterator in result.Body)) {
        return { ...result, Body: Readable.from([await result.Body.transformToByteArray()]) }
      }
      return result
    }, destroy: vi.fn() }),
  }
})
vi.mock('./image', () => ({ qualities: { archival: 90, balanced: 82, aggressive: 72 }, optimizeImage: compress }))

import { closeDatabase, getDatabase, getDatabaseConnection } from './db'
import { enqueueJob, enqueueReconciliation, getJobSummary, resumeJob, runNextJob } from './jobs'
import { objects, optimizationItems, optimizationJobs, scans } from './schema'
import { workerLease } from './worker-lease'
import { InvalidJpegError } from './failures'

let dir: string
let databaseNumber = 0
const previous = { DATABASE_PATH: process.env.DATABASE_PATH, R2_ENDPOINT: process.env.R2_ENDPOINT, R2_BUCKET: process.env.R2_BUCKET }
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'r2-jobs-test-'))
  process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com'
  process.env.R2_BUCKET = 'test'
})
beforeEach(() => {
  process.env.DATABASE_PATH = join(dir, `${++databaseNumber}.sqlite`)
  send.mockReset()
  compress.mockReset()
  configFailure.mockReset()
  manifestStore.clear()
  manifestRequest.mockReset()
})
afterEach(() => {
  workerLease.release()
  closeDatabase()
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function queueOne(key: string) {
  const db = getDatabase()
  const job = db.insert(optimizationJobs).values({ status: 'queued', preset: 'balanced',
    minimumSavingPercent: 15, backupOriginals: true, preserveMetadata: true,
    createdAt: new Date().toISOString() }).returning().get()
  const item = db.insert(optimizationItems).values({ jobId: job.id, key, etag: '"old"',
    originalSize: 100, status: 'pending', createdAt: new Date().toISOString() }).returning().get()
  return { job, item }
}

test('persists bounded retries across a restart for 503 and 429 responses', async () => {
  let heads = 0
  send.mockImplementation(async (command: unknown) => {
    if (!(command instanceof HeadObjectCommand)) throw new Error('Unexpected write or download')
    heads++
    if (heads === 1) throw { $metadata: { httpStatusCode: 503 } }
    if (heads === 2) throw { $metadata: { httpStatusCode: 429 } }
    return { ETag: '"changed"', ContentLength: 100, Metadata: {} }
  })
  const { job, item } = queueOne('retry.jpg')
  await runNextJob()
  const first = getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()!
  expect(first).toMatchObject({ status: 'retry_wait', attemptCount: 1, transientFailures: 1, errorKind: 'transient' })
  expect(first.nextAttemptAt! - Date.now()).toBeGreaterThan(0)
  expect(first.nextAttemptAt! - Date.now()).toBeLessThanOrEqual(2000)
  workerLease.release()
  closeDatabase()
  await runNextJob()
  expect(heads).toBe(1)
  getDatabase().update(optimizationItems).set({ nextAttemptAt: Date.now() - 1 }).where(eq(optimizationItems.id, item.id)).run()
  await runNextJob()
  const second = getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()!
  expect(second).toMatchObject({ status: 'retry_wait', attemptCount: 2, transientFailures: 2, errorKind: 'throttled' })
  expect(second.nextAttemptAt! - Date.now()).toBeGreaterThan(0)
  expect(second.nextAttemptAt! - Date.now()).toBeLessThanOrEqual(4000)
  getDatabase().update(optimizationItems).set({ nextAttemptAt: null }).where(eq(optimizationItems.id, item.id)).run()
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'completed' }, sourceChanged: 1, failed: 0 })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()?.attemptCount).toBe(3)
  expect(heads).toBe(3)
})

test('rechecks source and backup before retrying a 503 from the replacement PUT', async () => {
  const key = 'retry-put.jpg'
  const original = Buffer.alloc(100, 13)
  const store = new Map<string, { bytes: Buffer, etag: string, metadata: Record<string, string> }>([
    [key, { bytes: original, etag: '"old"', metadata: {} }],
  ])
  let sourcePuts = 0
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
      const object = store.get(command.input.Key!)
      if (!object) throw { $metadata: { httpStatusCode: 404 }, name: 'NoSuchKey' }
      if (command instanceof HeadObjectCommand) return { ETag: object.etag,
        ContentLength: object.bytes.length, Metadata: object.metadata }
      return { ETag: object.etag, ContentLength: object.bytes.length,
        Body: { transformToByteArray: async () => object.bytes } }
    }
    if (command instanceof PutObjectCommand) {
      if (command.input.IfNoneMatch === '*' && store.has(command.input.Key!)) throw { $metadata: { httpStatusCode: 412 } }
      if (command.input.Key === key && ++sourcePuts === 1) throw { $metadata: { httpStatusCode: 503 } }
      store.set(command.input.Key!, { bytes: Buffer.from(command.input.Body as Buffer),
        etag: '"new"', metadata: command.input.Metadata ?? {} })
      return { ETag: '"new"' }
    }
    throw new Error('Unexpected command')
  })
  compress.mockResolvedValue({ output: Buffer.alloc(70, 13), width: 10, height: 10 })
  const { job, item } = queueOne(key)
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'running' }, nextRetryAt: expect.any(Number),
    finalBytes: null })
  expect(store.get(key)?.bytes).toEqual(original)
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()).toMatchObject({
    status: 'retry_wait', errorKind: 'transient', backupVerifiedAt: expect.any(String),
    replacementAttemptedAt: expect.any(String),
  })
  getDatabase().update(optimizationItems).set({ nextAttemptAt: Date.now() - 1 }).where(eq(optimizationItems.id, item.id)).run()
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'completed' }, savedBytes: 30 })
  expect(sourcePuts).toBe(2)
  expect(store.get(key)?.bytes.length).toBe(70)
})

test('exhausts the application retry budget and reports completed_with_errors', async () => {
  send.mockRejectedValue({ $metadata: { httpStatusCode: 503 } })
  const { job, item } = queueOne('unavailable.jpg')
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) getDatabase().update(optimizationItems).set({ nextAttemptAt: Date.now() - 1 })
      .where(eq(optimizationItems.id, item.id)).run()
    await runNextJob()
  }
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'completed_with_errors' }, failed: 1, needsAttention: 0 })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()).toMatchObject({
    status: 'failed', errorKind: 'transient', attemptCount: 3, transientFailures: 3, nextAttemptAt: null,
  })
  expect(send).toHaveBeenCalledTimes(3)
})

test('pauses on credential failure and resumes from persisted state', async () => {
  send.mockRejectedValue({ $metadata: { httpStatusCode: 403 }, name: 'AccessDenied' })
  const { job, item } = queueOne('private.jpg')
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'paused', pauseReason: expect.stringContaining('credentials') },
    failed: 0 })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()).toMatchObject({
    status: 'pending', attemptCount: 1, errorKind: 'credentials',
  })
  workerLease.release()
  closeDatabase()
  send.mockResolvedValue({ ETag: '"changed"', ContentLength: 100, Metadata: {} })
  resumeJob(job.id)
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'completed', pauseReason: null }, sourceChanged: 1 })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()?.attemptCount).toBe(2)
})

test('pauses a queued job when credentials are missing at restart', async () => {
  const { job, item } = queueOne('missing-config.jpg')
  configFailure.mockReturnValueOnce(new Error('R2 connection is not configured'))
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'paused', pauseReason: expect.stringContaining('credentials') } })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()?.attemptCount).toBe(0)
  expect(send).not.toHaveBeenCalled()
})

test('pauses the job on a bucket-wide NoSuchBucket error', async () => {
  send.mockRejectedValue({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })
  const { job, item } = queueOne('missing-bucket.jpg')
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'paused', pauseReason: expect.stringContaining('bucket') } })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()).toMatchObject({
    status: 'pending', errorKind: 'bucket', attemptCount: 1,
  })
})

test('records an invalid JPEG separately and completes the job with errors', async () => {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: '"old"', ContentLength: 100, Metadata: {} }
    if (command instanceof GetObjectCommand) return { ETag: '"old"', ContentLength: 100,
      Body: { transformToByteArray: async () => Buffer.alloc(100, 1) } }
    throw new Error('Invalid input must not be uploaded')
  })
  compress.mockRejectedValue(new InvalidJpegError())
  const { job, item } = queueOne('broken.jpg')
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'completed_with_errors' }, invalidJpeg: 1, failed: 0 })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()).toMatchObject({
    status: 'invalid_jpeg', errorKind: 'invalid_jpeg', attemptCount: 1,
  })
  expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
})

test('treats a download 412 as a changed source before any backup or replacement', async () => {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: '"old"', ContentLength: 100, Metadata: {} }
    if (command instanceof GetObjectCommand) throw { $metadata: { httpStatusCode: 412 } }
    throw new Error('Changed source must not be uploaded')
  })
  const { job, item } = queueOne('changed-during-download.jpg')
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'completed' }, sourceChanged: 1,
    finalBytes: null, savedBytes: null })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()).toMatchObject({
    status: 'source_changed', errorKind: 'source_changed', attemptCount: 1,
  })
  expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
})

test('continues after backup failure, replaces only after verified backup, and skips low savings', async () => {
  const store = new Map<string, { bytes: Buffer, etag: string, metadata: Record<string, string> }>()
  for (const [index, letter] of ['a', 'b', 'c'].entries()) {
    store.set(`photos/${letter}.jpg`, { bytes: Buffer.alloc(100, index + 1), etag: `"${letter}"`, metadata: {} })
  }
  const writes: { key: string, ifMatch?: string, ifNoneMatch?: string }[] = []
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const value = store.get(command.input.Key!)
      if (!value) throw new Error('Not found')
      return { ContentLength: value.bytes.length, ETag: value.etag, Metadata: value.metadata, ContentType: 'image/jpeg' }
    }
    if (command instanceof GetObjectCommand) {
      const value = store.get(command.input.Key!)
      if (!value) throw new Error('Not found')
      if (command.input.IfMatch && command.input.IfMatch !== value.etag) throw new Error('ETag mismatch')
      return { ContentLength: value.bytes.length, ETag: value.etag, Body: { transformToByteArray: async () => value.bytes } }
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!
      writes.push({ key, ifMatch: command.input.IfMatch, ifNoneMatch: command.input.IfNoneMatch })
      if (key.startsWith('__optimizer/originals/') && Buffer.from(command.input.Body as Buffer)[0] === 1) throw new Error('Backup denied')
      if (command.input.IfNoneMatch === '*' && store.has(key)) throw new Error('Backup collision')
      if (command.input.IfMatch && store.get(key)?.etag !== command.input.IfMatch) throw new Error('Original changed')
      store.set(key, { bytes: Buffer.from(command.input.Body as Buffer), etag: '"new"', metadata: command.input.Metadata ?? {} })
      return { ETag: '"new"' }
    }
    throw new Error('Unexpected command')
  })
  compress.mockImplementation(async (bytes: Buffer) => ({ output: Buffer.alloc(bytes[0] === 3 ? 90 : 70, bytes[0]), width: 10, height: 10 }))

  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'photos/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  for (const letter of ['a', 'b', 'c']) db.insert(objects).values({ key: `photos/${letter}.jpg`, scanId: scan.id,
    etag: `"${letter}"`, size: 100, isJpeg: true, isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()

  const { job, count } = enqueueJob({ prefix: 'photos/', minBytes: 0, preset: 'balanced', minimumSavingPercent: 15, preserveMetadata: true, backupOriginals: true })
  expect(count).toBe(3)
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'needs_attention' }, completed: 1, skipped: 1,
    failed: 0, needsAttention: 1, originalBytes: 300, finalBytes: null, savedBytes: null })
  expect(store.get('photos/a.jpg')?.bytes.length).toBe(100)
  expect(store.get('photos/b.jpg')?.bytes.length).toBe(70)
  expect(store.get('photos/c.jpg')?.bytes.length).toBe(100)
  const backupIndex = writes.findIndex(write => write.key.startsWith(`__optimizer/originals/${job.id}/`) && store.get(write.key)?.bytes[0] === 2)
  const replaceIndex = writes.findIndex(write => write.key === 'photos/b.jpg')
  expect(backupIndex).toBeGreaterThanOrEqual(0)
  expect(replaceIndex).toBeGreaterThan(backupIndex)
  expect(writes[backupIndex]?.ifNoneMatch).toBe('*')
  expect(writes[replaceIndex]?.ifMatch).toBe('"b"')
  expect(store.get('photos/b.jpg')?.metadata['image-optimizer-version']).toBe('1')
  expect(db.select().from(objects).where(eq(objects.key, 'photos/b.jpg')).get()?.isOptimized).toBe(true)
  expect(db.select().from(optimizationItems).where(eq(optimizationItems.key, 'photos/b.jpg')).get()).toMatchObject({
    status: 'completed', backupVerifiedAt: expect.any(String), manifestVerifiedAt: expect.any(String),
    manifestKey: expect.any(String), replacementAttemptedAt: expect.any(String),
  })
  const completedItem = db.select().from(optimizationItems).where(eq(optimizationItems.key, 'photos/b.jpg')).get()!
  const manifest = JSON.parse(manifestStore.get(completedItem.manifestKey!)!.toString('utf8'))
  expect(manifest).toMatchObject({ version: 1, bucket: 'test', jobId: job.id, itemId: completedItem.id,
    originalKey: 'photos/b.jpg', backupKey: completedItem.backupKey,
    sha256: completedItem.originalSha256, size: 100,
    headers: { contentType: 'image/jpeg', metadata: {} } })
  const itemRequests = send.mock.calls.filter(([command]) =>
    (command as HeadObjectCommand).input?.Key === 'photos/b.jpg' ||
    (command as HeadObjectCommand).input?.Key === completedItem.backupKey).length
  const itemManifestRequests = manifestRequest.mock.calls.filter(([command]) =>
    (command as GetObjectCommand).input.Key === completedItem.manifestKey).length
  expect({ itemRequests, itemManifestRequests, total: itemRequests + itemManifestRequests })
    .toEqual({ itemRequests: 10, itemManifestRequests: 4, total: 14 })
})

test('does not replace a source when an existing manifest conflicts with its verified backup', async () => {
  const key = 'manifest-conflict.jpg'
  const original = Buffer.alloc(100, 4)
  const { job, item } = queueOne(key)
  const backupKey = `__optimizer/originals/${job.id}/${createHash('sha256').update(key).digest('hex')}.jpg`
  const manifestKey = `__optimizer/manifests/${backupKey.slice('__optimizer/originals/'.length)}.json`
  manifestStore.set(manifestKey, Buffer.from('{"unexpected":true}'))
  let sourcePuts = 0
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: '"old"', ContentLength: 100, Metadata: {} }
    if (command instanceof GetObjectCommand) return { ETag: '"old"', ContentLength: 100,
      Body: { transformToByteArray: async () => original } }
    if (command instanceof PutObjectCommand) {
      if (command.input.Key === key) sourcePuts++
      return {}
    }
    throw new Error('Unexpected command')
  })
  compress.mockResolvedValue({ output: Buffer.alloc(70, 4), width: 10, height: 10 })
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'needs_attention' }, needsAttention: 1 })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()?.manifestVerifiedAt).toBeNull()
  expect(sourcePuts).toBe(0)
})

test('refuses replacement when the backup loses an original object header', async () => {
  const key = 'header-mismatch.jpg'
  const original = Buffer.alloc(100, 4)
  let sourcePuts = 0
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: '"old"', ContentLength: 100,
      CacheControl: command.input.Key === key ? 'private, max-age=60' : 'public', Metadata: {} }
    if (command instanceof GetObjectCommand) return { ETag: '"old"', ContentLength: 100,
      Body: { transformToByteArray: async () => original } }
    if (command instanceof PutObjectCommand) {
      if (command.input.Key === key) sourcePuts++
      return {}
    }
    throw new Error('Unexpected command')
  })
  compress.mockResolvedValue({ output: Buffer.alloc(70, 4), width: 10, height: 10 })
  const { job, item } = queueOne(key)
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'needs_attention' }, needsAttention: 1 })
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()?.error)
    .toBe('Backup object headers differ from the original')
  expect(sourcePuts).toBe(0)
})

test('reconciles an upload completed before the worker could save its result', async () => {
  const db = getDatabase()
  const job = db.insert(optimizationJobs).values({ status: 'running', preset: 'balanced',
    minimumSavingPercent: 15, backupOriginals: true, preserveMetadata: true, createdAt: new Date().toISOString() }).returning().get()
  const optimized = Buffer.alloc(70, 9)
  const original = Buffer.alloc(100, 9)
  const backupKey = '__optimizer/originals/recovered.jpg'
  const item = db.insert(optimizationItems).values({ jobId: job.id, key: 'photos/recovered.jpg', etag: '"old"',
    originalSize: 100, optimizedSize: 70, backupKey,
    originalSha256: createHash('sha256').update(original).digest('hex'),
    optimizedSha256: createHash('sha256').update(optimized).digest('hex'),
    replacementAttemptedAt: new Date().toISOString(),
    status: 'uploading', createdAt: new Date().toISOString() }).returning().get()
  closeDatabase() // Simulate the process restarting with only the persisted intent available.
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: '"new"', ContentLength: 70,
      Metadata: { 'image-optimizer-version': '1', 'image-optimizer-job-id': String(job.id), 'image-optimizer-item-id': String(item.id) } }
    if (command instanceof GetObjectCommand) {
      const bytes = command.input.Key === backupKey ? original : optimized
      return { ETag: '"new"', ContentLength: bytes.length, Body: { transformToByteArray: async () => bytes } }
    }
    throw new Error('A recovered upload must not be written again')
  })
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ completed: 1, failed: 0, savedBytes: 30 })
  expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
  expect(getDatabase().select().from(optimizationItems).where(eq(optimizationItems.id, item.id)).get()?.backupVerifiedAt).toBeTruthy()
})

test('selects only known, unoptimized JPEGs matching a literal prefix and size', async () => {
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: '', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  const candidates = [
    { key: 'photos/%-eligible.jpg', size: 200, isJpeg: true, isOptimized: false, metadataStatus: 'known' },
    { key: 'photos/%-small.jpg', size: 50, isJpeg: true, isOptimized: false, metadataStatus: 'known' },
    { key: 'photos/%-unknown.jpg', size: 200, isJpeg: true, isOptimized: null, metadataStatus: 'unknown' },
    { key: 'photos/%-done.jpg', size: 200, isJpeg: true, isOptimized: true, metadataStatus: 'known' },
    { key: 'photos/%-text.txt', size: 200, isJpeg: false, isOptimized: null, metadataStatus: 'not_applicable' },
    { key: 'photos/x-other.jpg', size: 200, isJpeg: true, isOptimized: false, metadataStatus: 'known' },
  ] as const
  for (const candidate of candidates) db.insert(objects).values({ ...candidate, scanId: scan.id, etag: '"old"', discoveredAt: new Date().toISOString() }).run()
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: '"changed"', ContentLength: 200, Metadata: {} }
    throw new Error('Ineligible candidate reached R2')
  })
  const { job, count } = enqueueJob({ prefix: 'photos/%-', minBytes: 100, preset: 'balanced',
    minimumSavingPercent: 15, preserveMetadata: true, backupOriginals: true })
  expect(count).toBe(1)
  await runNextJob()
  expect(db.select().from(optimizationItems).where(eq(optimizationItems.jobId, job.id)).all()).toMatchObject([
    { key: 'photos/%-eligible.jpg', status: 'source_changed', errorKind: 'source_changed', error: 'Object changed since the scan' },
  ])
  expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
})

test('creates more than two batches in key order', () => {
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'batch/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  db.transaction((tx) => {
    for (let index = 204; index >= 0; index--) tx.insert(objects).values({
      key: `batch/${String(index).padStart(3, '0')}.jpg`, scanId: scan.id, etag: '"old"', size: 100,
      isJpeg: true, isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString(),
    }).run()
  })
  const lease = vi.spyOn(workerLease, 'tryAcquire').mockReturnValue(false)
  try {
    const { job, count } = enqueueJob({ prefix: 'batch/', minBytes: 0, preset: 'balanced',
      minimumSavingPercent: 15, preserveMetadata: true, backupOriginals: true })
    expect(count).toBe(205)
    const items = db.select({ key: optimizationItems.key }).from(optimizationItems).where(eq(optimizationItems.jobId, job.id)).all()
    expect(items.map(item => item.key)).toEqual(Array.from({ length: 205 }, (_, index) => `batch/${String(index).padStart(3, '0')}.jpg`))
    expect(send).not.toHaveBeenCalled()
  } finally { lease.mockRestore() }
})

test.skipIf(!process.env.PERF_BENCH)('measures large job creation without R2 requests', () => {
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'bench/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  db.transaction((tx) => {
    for (let index = 0; index < 5000; index++) tx.insert(objects).values({
      key: `bench/${String(index).padStart(6, '0')}.jpg`, scanId: scan.id, etag: '"old"', size: 100,
      isJpeg: true, isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString(),
    }).run()
  })
  const lease = vi.spyOn(workerLease, 'tryAcquire').mockReturnValue(false)
  const before = process.memoryUsage()
  const start = performance.now()
  const result = enqueueJob({ prefix: 'bench/', minBytes: 0, preset: 'balanced',
    minimumSavingPercent: 15, preserveMetadata: true, backupOriginals: true })
  const elapsedMs = Math.round(performance.now() - start)
  const after = process.memoryUsage()
  lease.mockRestore()
  expect(result.count).toBe(5000)
  expect(send).not.toHaveBeenCalled()
  console.log(JSON.stringify({ benchmark: 'create-5000-items', elapsedMs,
    heapDeltaMiB: Math.round((after.heapUsed - before.heapUsed) / 1048576),
    rssDeltaMiB: Math.round((after.rss - before.rss) / 1048576), r2Requests: send.mock.calls.length }))
})

test('refuses to replace a source when the backup readback differs', async () => {
  const key = 'safety/backup-mismatch.jpg'
  const original = Buffer.alloc(100, 4)
  let source = original
  let backup: Buffer | undefined
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: '"old"', ContentLength: source.length, Metadata: {} }
    if (command instanceof GetObjectCommand) {
      const bytes = command.input.Key === key ? source : backup
      if (!bytes) throw new Error('Missing backup')
      return { ETag: '"old"', ContentLength: bytes.length, Body: { transformToByteArray: async () => bytes } }
    }
    if (command instanceof PutObjectCommand) {
      if (command.input.Key === key) { source = Buffer.from(command.input.Body as Buffer); return {} }
      backup = Buffer.alloc(100, 8)
      return {}
    }
    throw new Error('Unexpected command')
  })
  compress.mockResolvedValue({ output: Buffer.alloc(70, 4), width: 10, height: 10 })
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'safety/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  db.insert(objects).values({ key, scanId: scan.id, etag: '"old"', size: 100, isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()
  const { job } = enqueueJob({ prefix: 'safety/', minBytes: 0, preset: 'balanced',
    minimumSavingPercent: 15, preserveMetadata: true, backupOriginals: true })
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'needs_attention' }, completed: 0,
    failed: 0, needsAttention: 1, finalBytes: null })
  expect(db.select().from(optimizationItems).where(eq(optimizationItems.jobId, job.id)).get()?.error).toBe('Backup verification failed')
  expect(source).toEqual(original)
  expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand && command.input.Key === key)).toHaveLength(0)
})

test('reconciles a successful replacement whose PUT response was lost', async () => {
  const key = 'safety/lost-response.jpg'
  const original = Buffer.alloc(100, 5)
  let source = original
  let sourceEtag = '"old"'
  let sourceMetadata: Record<string, string> = {}
  let backup: Buffer | undefined
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return command.input.Key === key
      ? { ETag: sourceEtag, ContentLength: source.length, Metadata: sourceMetadata }
      : { ETag: '"backup"', ContentLength: backup?.length, Metadata: {} }
    if (command instanceof GetObjectCommand) {
      const bytes = command.input.Key === key ? source : backup
      if (!bytes) throw new Error('Missing backup')
      return { ETag: command.input.Key === key ? sourceEtag : '"backup"', ContentLength: bytes.length,
        Body: { transformToByteArray: async () => bytes } }
    }
    if (command instanceof PutObjectCommand) {
      if (command.input.Key === key) {
        source = Buffer.from(command.input.Body as Buffer)
        sourceEtag = '"new"'
        sourceMetadata = command.input.Metadata ?? {}
        throw new Error('Connection dropped after upload')
      }
      backup = Buffer.from(command.input.Body as Buffer)
      return {}
    }
    throw new Error('Unexpected command')
  })
  compress.mockResolvedValue({ output: Buffer.alloc(70, 5), width: 10, height: 10 })
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'safety/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  db.insert(objects).values({ key, scanId: scan.id, etag: '"old"', size: 100, isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()
  const { job } = enqueueJob({ prefix: key, minBytes: 0, preset: 'balanced',
    minimumSavingPercent: 15, preserveMetadata: true, backupOriginals: true })
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ completed: 1, failed: 0, savedBytes: 30 })
  expect(source.length).toBe(70)
  expect(backup).toEqual(original)
  expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand && command.input.Key === key)).toHaveLength(1)
})

test('marks a successful but temporarily unverifiable replacement for attention, then reconciles it without another PUT', async () => {
  const key = 'safety/verify-timeout.jpg'
  const original = Buffer.alloc(100, 11)
  const store = new Map<string, { bytes: Buffer, etag: string, metadata: Record<string, string> }>([
    [key, { bytes: original, etag: '"old"', metadata: {} }],
  ])
  let failVerificationHead = false
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      if (failVerificationHead) { failVerificationHead = false; throw new Error('Verification unavailable') }
      const value = store.get(command.input.Key!)!
      return { ContentLength: value.bytes.length, ETag: value.etag, Metadata: value.metadata }
    }
    if (command instanceof GetObjectCommand) {
      const value = store.get(command.input.Key!)
      if (!value) throw { $metadata: { httpStatusCode: 404 } }
      return { ContentLength: value.bytes.length, ETag: value.etag,
        Body: { transformToByteArray: async () => value.bytes } }
    }
    if (command instanceof PutObjectCommand) {
      const keyToWrite = command.input.Key!
      store.set(keyToWrite, { bytes: Buffer.from(command.input.Body as Buffer), etag: '"new"', metadata: command.input.Metadata ?? {} })
      if (keyToWrite === key) failVerificationHead = true
      return { ETag: '"new"' }
    }
    throw new Error('Unexpected command')
  })
  compress.mockResolvedValue({ output: Buffer.alloc(70, 11), width: 10, height: 10 })
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'safety/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  db.insert(objects).values({ key, scanId: scan.id, etag: '"old"', size: 100, isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()
  const { job } = enqueueJob({ prefix: key, minBytes: 0, preset: 'balanced', minimumSavingPercent: 15,
    preserveMetadata: true, backupOriginals: true })
  await runNextJob()
  expect(store.get(key)?.bytes.length).toBe(70)
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'needs_attention' }, completed: 0,
    needsAttention: 1, finalBytes: null, savedBytes: null })
  expect(db.select().from(optimizationItems).where(eq(optimizationItems.jobId, job.id)).get()).toMatchObject({
    backupVerifiedAt: expect.any(String), replacementAttemptedAt: expect.any(String),
  })
  enqueueReconciliation(job.id)
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'completed' }, completed: 1,
    needsAttention: 0, finalBytes: 70, savedBytes: 30 })
  expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand && command.input.Key === key)).toHaveLength(1)
})

test('retries only after confirming the original and verified backup still match', async () => {
  const key = 'safety/put-timeout.jpg'
  const original = Buffer.alloc(100, 12)
  const store = new Map<string, { bytes: Buffer, etag: string, metadata: Record<string, string> }>([
    [key, { bytes: original, etag: '"old"', metadata: {} }],
  ])
  let sourcePuts = 0
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const value = store.get(command.input.Key!)!
      return { ContentLength: value.bytes.length, ETag: value.etag, Metadata: value.metadata }
    }
    if (command instanceof GetObjectCommand) {
      const value = store.get(command.input.Key!)
      if (!value) throw { $metadata: { httpStatusCode: 404 } }
      return { ContentLength: value.bytes.length, ETag: value.etag,
        Body: { transformToByteArray: async () => value.bytes } }
    }
    if (command instanceof PutObjectCommand) {
      const keyToWrite = command.input.Key!
      if (command.input.IfNoneMatch === '*' && store.has(keyToWrite)) throw { $metadata: { httpStatusCode: 412 } }
      if (keyToWrite === key && ++sourcePuts === 1) throw new Error('PUT outcome unavailable')
      store.set(keyToWrite, { bytes: Buffer.from(command.input.Body as Buffer), etag: '"new"', metadata: command.input.Metadata ?? {} })
      return { ETag: '"new"' }
    }
    throw new Error('Unexpected command')
  })
  compress.mockResolvedValue({ output: Buffer.alloc(70, 12), width: 10, height: 10 })
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'safety/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  db.insert(objects).values({ key, scanId: scan.id, etag: '"old"', size: 100, isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()
  const { job } = enqueueJob({ prefix: key, minBytes: 0, preset: 'balanced', minimumSavingPercent: 15,
    preserveMetadata: true, backupOriginals: true })
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'needs_attention' }, needsAttention: 1, finalBytes: null })
  expect(store.get(key)?.bytes).toEqual(original)
  const backupKey = db.select().from(optimizationItems).where(eq(optimizationItems.jobId, job.id)).get()!.backupKey!
  store.set(backupKey, { bytes: Buffer.alloc(100, 99), etag: '"corrupt"', metadata: {} })
  enqueueReconciliation(job.id)
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'needs_attention' }, needsAttention: 1, finalBytes: null })
  expect(db.select().from(optimizationItems).where(eq(optimizationItems.jobId, job.id)).get()?.error)
    .toContain('Backup hash differs')
  expect(sourcePuts).toBe(1)
  store.delete(backupKey)
  enqueueReconciliation(job.id)
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ job: { status: 'completed' }, completed: 1, savedBytes: 30 })
  expect(store.get(backupKey)?.bytes).toEqual(original)
  expect(sourcePuts).toBe(2)
  expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand && command.input.Key === key)
    .every(([command]) => command.input.IfMatch === '"old"')).toBe(true)
})

test('accepts a matching preexisting backup but never overwrites a source changed before replacement', async () => {
  const key = 'safety/conflict.jpg'
  const original = Buffer.alloc(100, 6)
  let changed = false
  const preconditionFailed = { $metadata: { httpStatusCode: 412 } }
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: changed ? '"external"' : '"old"', ContentLength: 100, Metadata: {} }
    if (command instanceof GetObjectCommand) return { ETag: '"old"', ContentLength: 100,
      Body: { transformToByteArray: async () => original } }
    if (command instanceof PutObjectCommand) {
      if (command.input.Key === key) changed = true
      throw preconditionFailed
    }
    throw new Error('Unexpected command')
  })
  compress.mockResolvedValue({ output: Buffer.alloc(70, 6), width: 10, height: 10 })
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'safety/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  db.insert(objects).values({ key, scanId: scan.id, etag: '"old"', size: 100, isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()
  const { job } = enqueueJob({ prefix: key, minBytes: 0, preset: 'balanced',
    minimumSavingPercent: 15, preserveMetadata: true, backupOriginals: true })
  await runNextJob()
  const item = db.select().from(optimizationItems).where(eq(optimizationItems.jobId, job.id)).get()
  expect(item).toMatchObject({ status: 'needs_attention', errorKind: 'source_changed',
    error: expect.stringContaining('Source differs') })
  expect(item?.backupKey).toBeTruthy()
  expect(changed).toBe(true)
  expect(db.select().from(objects).where(eq(objects.key, key)).get()?.isOptimized).toBe(false)
})

test('stops before upload after lease loss and resumes the unfinished item under a new claim', async () => {
  const key = 'safety/lease-loss.jpg'
  const original = Buffer.alloc(100, 7)
  const store = new Map<string, { bytes: Buffer, etag: string, metadata: Record<string, string> }>([
    [key, { bytes: original, etag: '"old"', metadata: {} }],
  ])
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const value = store.get(command.input.Key!)
      if (!value) throw new Error('Missing object')
      return { ETag: value.etag, ContentLength: value.bytes.length, Metadata: value.metadata }
    }
    if (command instanceof GetObjectCommand) {
      const value = store.get(command.input.Key!)
      if (!value) throw new Error('Missing object')
      return { ETag: value.etag, ContentLength: value.bytes.length,
        Body: { transformToByteArray: async () => value.bytes } }
    }
    if (command instanceof PutObjectCommand) {
      store.set(command.input.Key!, { bytes: Buffer.from(command.input.Body as Buffer), etag: '"new"', metadata: command.input.Metadata ?? {} })
      return { ETag: '"new"' }
    }
    throw new Error('Unexpected command')
  })
  let attempts = 0
  compress.mockImplementation(async () => {
    if (++attempts === 1) getDatabaseConnection().prepare("UPDATE worker_lease SET owner = 'takeover', expires_at = ? WHERE name = 'worker'")
      .run(Date.now() + 60_000)
    return { output: Buffer.alloc(70, 7), width: 10, height: 10 }
  })
  const db = getDatabase()
  const scan = db.insert(scans).values({ prefix: 'safety/', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  db.insert(objects).values({ key, scanId: scan.id, etag: '"old"', size: 100, isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()
  const { job } = enqueueJob({ prefix: key, minBytes: 0, preset: 'balanced',
    minimumSavingPercent: 15, preserveMetadata: true, backupOriginals: true })
  await runNextJob()
  expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
  expect(db.select().from(optimizationJobs).where(eq(optimizationJobs.id, job.id)).get()?.status).toBe('running')
  expect(db.select().from(optimizationItems).where(eq(optimizationItems.jobId, job.id)).get()?.status).toBe('processing')
  getDatabaseConnection().prepare("DELETE FROM worker_lease WHERE name = 'worker'").run()
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ completed: 1, failed: 0, savedBytes: 30 })
  expect(store.get(key)?.bytes.length).toBe(70)
})
