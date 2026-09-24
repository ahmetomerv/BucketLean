import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('./r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./r2')>()
  return {
    ...actual,
    r2Config: () => ({ id: 'default', endpoint: 'https://example.r2.cloudflarestorage.com', bucket: 'test', accessKeyId: 'x', secretAccessKey: 'x' }),
    createR2Client: () => ({ send, destroy: vi.fn() }),
  }
})

import { HeadObjectCommand, ListObjectsV2Command } from './r2'
import { closeDatabase, getDatabase, getDatabaseConnection } from './db'
import { enqueueScan, isJpegKey, runNextScan } from './scanner'
import { objects, scans } from './schema'
import { workerLease } from './worker-lease'

let dir: string
const previous = { DATABASE_PATH: process.env.DATABASE_PATH, R2_ENDPOINT: process.env.R2_ENDPOINT, R2_BUCKET: process.env.R2_BUCKET, R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY }
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'r2-optimizer-test-'))
  process.env.DATABASE_PATH = join(dir, 'test.sqlite')
  process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com'
  process.env.R2_BUCKET = 'test'
  process.env.R2_ACCESS_KEY_ID = 'x'
  process.env.R2_SECRET_ACCESS_KEY = 'x'
})
afterAll(() => {
  workerLease.release()
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('persists paginated JPEG discovery and treats metadata errors as unknown', async () => {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      if (!command.input.ContinuationToken) return {
        Contents: [
          { Key: 'photos/a.JPG', Size: 2_000_000, ETag: 'etag-a', LastModified: new Date('2026-01-01') },
          { Key: 'photos/b.jpeg', Size: 3_000_000, ETag: 'etag-b' },
        ], IsTruncated: true, NextContinuationToken: 'next',
      }
      return { Contents: [
        { Key: 'photos/c.jpg', Size: 4_000_000 },
        { Key: 'photos/readme.txt', Size: 100 },
      ], IsTruncated: false }
    }
    if (command instanceof HeadObjectCommand) {
      if (command.input.Key === 'photos/b.jpeg') return { Metadata: { 'image-optimizer-version': '1' } }
      if (command.input.Key === 'photos/c.jpg') throw new Error('HeadObject unavailable')
      return { Metadata: {} }
    }
    throw new Error('Unexpected command')
  })

  const { scan, created } = enqueueScan('photos/')
  expect(created).toBe(true)
  await runNextScan()
  const db = getDatabase()
  const finished = db.select().from(scans).where(eq(scans.id, scan.id)).get()
  expect(finished).toMatchObject({ status: 'completed', discoveredCount: 4, jpegCount: 3, metadataErrorCount: 1 })
  const rows = db.select().from(objects).where(eq(objects.scanId, scan.id)).all()
  expect(rows.find(row => row.key === 'photos/a.JPG')).toMatchObject({ isJpeg: true, isOptimized: false, metadataStatus: 'known' })
  expect(rows.find(row => row.key === 'photos/b.jpeg')).toMatchObject({ isJpeg: true, isOptimized: true, optimizerVersion: '1' })
  expect(rows.find(row => row.key === 'photos/c.jpg')).toMatchObject({ isJpeg: true, isOptimized: null, metadataStatus: 'unknown' })
  expect(rows.find(row => row.key === 'photos/readme.txt')).toMatchObject({ isJpeg: false, metadataStatus: 'not_applicable' })
  expect(send.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)).toHaveLength(3)
})

test('resumes a saved continuation token without repeating completed pages', async () => {
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      expect(command.input.ContinuationToken).toBe('saved-page')
      return { Contents: [{ Key: 'other/second.jpg', Size: 2_000_000 }], IsTruncated: false }
    }
    if (command instanceof HeadObjectCommand) return { Metadata: {} }
    throw new Error('Unexpected command')
  })
  const db = getDatabase()
  const scan = db.insert(scans).values({ bucketId: 'default', prefix: 'other/', status: 'running', cursor: 'saved-page', createdAt: new Date().toISOString() }).returning().get()
  db.insert(objects).values({
    bucketId: 'default', scanId: scan.id, key: 'other/first.jpg', size: 1_000_000, isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString(),
  }).run()
  await runNextScan()
  expect(db.select().from(scans).where(eq(scans.id, scan.id)).get()).toMatchObject({ status: 'completed', discoveredCount: 2, jpegCount: 2 })
  expect(send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command)).toHaveLength(1)
})

test('excludes reserved backup objects from JPEG candidates', () => {
  expect(isJpegKey('__optimizer/originals/a.jpg')).toBe(false)
  expect(isJpegKey('photos/a.JPEG')).toBe(true)
})

test('records a listing failure and keeps the last committed page', async () => {
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      if (command.input.ContinuationToken === 'second') throw new Error('R2 listing unavailable')
      return { Contents: [{ Key: 'failed/first.jpg', Size: 100, ETag: '"first"' }], IsTruncated: true, NextContinuationToken: 'second' }
    }
    if (command instanceof HeadObjectCommand) return { Metadata: {} }
    throw new Error('Unexpected command')
  })
  const { scan } = enqueueScan('failed/')
  await runNextScan()
  const db = getDatabase()
  expect(db.select().from(scans).where(eq(scans.id, scan.id)).get()).toMatchObject({
    status: 'failed', cursor: 'second', discoveredCount: 1, jpegCount: 1, error: 'R2 listing unavailable',
  })
  expect(db.select().from(objects).where(eq(objects.scanId, scan.id)).all()).toHaveLength(1)
})

test('restarts an interrupted first page from the beginning without duplicate rows', async () => {
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) return {
      Contents: [{ Key: 'restart/first.jpg', Size: 200, ETag: '"current"' }, { Key: 'restart/second.jpg', Size: 300 }],
      IsTruncated: false,
    }
    if (command instanceof HeadObjectCommand) return { Metadata: {} }
    throw new Error('Unexpected command')
  })
  const db = getDatabase()
  const scan = db.insert(scans).values({ bucketId: 'default', prefix: 'restart/', status: 'running', createdAt: new Date().toISOString() }).returning().get()
  db.insert(objects).values({ bucketId: 'default', scanId: scan.id, key: 'restart/first.jpg', size: 100, etag: '"old"', isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()
  await runNextScan()
  expect(db.select().from(scans).where(eq(scans.id, scan.id)).get()).toMatchObject({ status: 'completed', discoveredCount: 2, jpegCount: 2 })
  const rows = db.select().from(objects).where(eq(objects.scanId, scan.id)).all()
  expect(rows).toHaveLength(2)
  expect(rows.find(row => row.key === 'restart/first.jpg')).toMatchObject({ size: 200, etag: '"current"' })
})

test('leaves a queued scan untouched while another process owns the worker lease', async () => {
  workerLease.release()
  const db = getDatabase()
  const connection = getDatabaseConnection()
  connection.prepare("INSERT INTO worker_lease (name, owner, expires_at) VALUES ('worker', 'other-process', ?)").run(Date.now() + 60_000)
  send.mockClear()
  const { scan } = enqueueScan('guarded/')
  expect(db.select().from(scans).where(eq(scans.id, scan.id)).get()?.status).toBe('queued')
  expect(send).not.toHaveBeenCalled()
  connection.prepare("DELETE FROM worker_lease WHERE name = 'worker'").run()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) return { Contents: [], IsTruncated: false }
    throw new Error('Unexpected command')
  })
  await runNextScan()
  expect(db.select().from(scans).where(eq(scans.id, scan.id)).get()?.status).toBe('completed')
})

test('does not commit a scanned object after losing its lease and can restart the page', async () => {
  let firstHead = true
  send.mockClear()
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) return {
      Contents: [{ Key: 'lease-lost/photo.jpg', Size: 100, ETag: '"old"' }], IsTruncated: false,
    }
    if (command instanceof HeadObjectCommand) {
      if (firstHead) {
        firstHead = false
        getDatabaseConnection().prepare("UPDATE worker_lease SET owner = 'takeover', expires_at = ? WHERE name = 'worker'")
          .run(Date.now() + 60_000)
      }
      return { Metadata: {} }
    }
    throw new Error('Unexpected command')
  })
  const { scan } = enqueueScan('lease-lost/')
  await runNextScan()
  const db = getDatabase()
  expect(db.select().from(scans).where(eq(scans.id, scan.id)).get()?.status).toBe('running')
  expect(db.select().from(objects).where(eq(objects.scanId, scan.id)).all()).toHaveLength(0)
  getDatabaseConnection().prepare("DELETE FROM worker_lease WHERE name = 'worker'").run()
  await runNextScan()
  expect(db.select().from(scans).where(eq(scans.id, scan.id)).get()).toMatchObject({ status: 'completed', discoveredCount: 1 })
})
