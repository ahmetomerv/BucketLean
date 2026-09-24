import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

const { send, compress } = vi.hoisted(() => ({ send: vi.fn(), compress: vi.fn() }))
vi.mock('./r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./r2')>()
  return { ...actual,
    r2Config: () => ({ endpoint: 'https://example.r2.cloudflarestorage.com', bucket: 'test', accessKeyId: 'x', secretAccessKey: 'x' }),
    createR2Client: () => ({ send, destroy: vi.fn() }),
  }
})
vi.mock('./image', () => ({ qualities: { archival: 90, balanced: 82, aggressive: 72 }, optimizeImage: compress }))

import { closeDatabase, getDatabase } from './db'
import { enqueueJob, getJobSummary, runNextJob } from './jobs'
import { objects, optimizationItems, optimizationJobs, scans } from './schema'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'r2-jobs-test-'))
  process.env.DATABASE_PATH = join(dir, 'test.sqlite')
})
afterAll(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); delete process.env.DATABASE_PATH })

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
  expect(getJobSummary(job.id)).toMatchObject({ completed: 1, skipped: 1, failed: 1, originalBytes: 300, finalBytes: 270, savedBytes: 30 })
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
})

test('reconciles an upload completed before the worker could save its result', async () => {
  const db = getDatabase()
  const job = db.insert(optimizationJobs).values({ status: 'running', preset: 'balanced',
    minimumSavingPercent: 15, backupOriginals: true, preserveMetadata: true, createdAt: new Date().toISOString() }).returning().get()
  const optimized = Buffer.alloc(70, 9)
  const item = db.insert(optimizationItems).values({ jobId: job.id, key: 'photos/recovered.jpg', etag: '"old"',
    originalSize: 100, optimizedSize: 70, optimizedSha256: createHash('sha256').update(optimized).digest('hex'),
    status: 'uploading', createdAt: new Date().toISOString() }).returning().get()
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ETag: '"new"', ContentLength: 70,
      Metadata: { 'image-optimizer-version': '1', 'image-optimizer-job-id': String(job.id), 'image-optimizer-item-id': String(item.id) } }
    if (command instanceof GetObjectCommand) return { ETag: '"new"', ContentLength: 70,
      Body: { transformToByteArray: async () => optimized } }
    throw new Error('A recovered upload must not be written again')
  })
  await runNextJob()
  expect(getJobSummary(job.id)).toMatchObject({ completed: 1, failed: 0, savedBytes: 30 })
  expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
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
    { key: 'photos/%-eligible.jpg', status: 'skipped', error: 'Object changed since the scan' },
  ])
  expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
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
  expect(getJobSummary(job.id)).toMatchObject({ completed: 0, failed: 1 })
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
    if (command instanceof HeadObjectCommand) return { ETag: sourceEtag, ContentLength: source.length, Metadata: sourceMetadata }
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
  expect(item).toMatchObject({ status: 'failed', error: 'Object changed before replacement; verified backup was retained' })
  expect(item?.backupKey).toBeTruthy()
  expect(changed).toBe(true)
  expect(db.select().from(objects).where(eq(objects.key, key)).get()?.isOptimized).toBe(false)
})
