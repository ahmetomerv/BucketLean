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
