import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { createApp, createError, createRouter, defineEventHandler, getHeader, getQuery, setHeader, toWebHandler } from 'h3'
import { getDatabase, closeDatabase } from '../../utils/db'
import { objects, scans } from '../../utils/schema'

const { send, destroy } = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }))
vi.mock('../../utils/r2', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../utils/r2')>(),
  r2Config: () => ({ id: 'default', endpoint: 'https://example.r2.cloudflarestorage.com', bucket: 'test', accessKeyId: 'x', secretAccessKey: 'x' }),
  createR2Client: () => ({ send, destroy }),
}))

let directory: string
let request: ReturnType<typeof toWebHandler>
let keyNumber = 0
const previous = { DATABASE_PATH: process.env.DATABASE_PATH, APP_PASSWORD: process.env.APP_PASSWORD,
  R2_ENDPOINT: process.env.R2_ENDPOINT, R2_BUCKET: process.env.R2_BUCKET,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKETS_JSON: process.env.R2_BUCKETS_JSON }

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'bucketlean-preview-test-'))
  process.env.DATABASE_PATH = join(directory, 'test.sqlite')
  process.env.APP_PASSWORD = 'test-password'
  process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com'
  process.env.R2_BUCKET = 'test'
  process.env.R2_ACCESS_KEY_ID = 'x'
  process.env.R2_SECRET_ACCESS_KEY = 'x'
  delete process.env.R2_BUCKETS_JSON
  for (const [name, value] of Object.entries({ createError, defineEventHandler, getHeader, getQuery, setHeader })) vi.stubGlobal(name, value)
  const [auth, preview] = await Promise.all([import('../../middleware/auth'), import('./preview.get')])
  const router = createRouter()
  router.get('/api/objects/preview', preview.default)
  const app = createApp()
  app.use(auth.default)
  app.use(router.handler)
  request = toWebHandler(app)
})

beforeEach(() => { send.mockReset(); destroy.mockClear() })

afterAll(() => {
  closeDatabase()
  rmSync(directory, { recursive: true, force: true })
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.unstubAllGlobals()
})

function scannedObject(size: number, etag: string | null = '"scanned"') {
  const db = getDatabase()
  const scan = db.insert(scans).values({ bucketId: 'default', prefix: '', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  const key = `photos/preview-${++keyNumber}.jpg`
  db.insert(objects).values({ bucketId: 'default', scanId: scan.id, key, size, etag, isJpeg: true,
    isOptimized: false, metadataStatus: 'known', discoveredAt: new Date().toISOString() }).run()
  return { key, scanId: scan.id }
}

function call(key: string, scanId: number, authorized = true) {
  const query = new URLSearchParams({ bucketId: 'default', key, scanId: String(scanId) })
  const headers = authorized ? { authorization: `Basic ${Buffer.from('user:test-password').toString('base64')}` } : {}
  return request(new Request(`http://localhost/api/objects/preview?${query}`, { headers }))
}

test('returns a small rotated JPEG from the scanned source without writing to R2', async () => {
  const original = await sharp({ create: { width: 240, height: 120, channels: 3, background: '#ee7800' } }).jpeg().toBuffer()
  const { key, scanId } = scannedObject(original.length)
  send.mockImplementation(async (command: unknown) => {
    expect(command).toBeInstanceOf(GetObjectCommand)
    expect((command as GetObjectCommand).input).toMatchObject({ Bucket: 'test', Key: key, IfMatch: '"scanned"' })
    return { Body: Readable.from([original]), ContentLength: original.length, ETag: '"scanned"' }
  })

  const response = await call(key, scanId)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('image/jpeg')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const thumbnail = Buffer.from(await response.arrayBuffer())
  expect(thumbnail.length).toBeLessThan(original.length)
  expect(await sharp(thumbnail).metadata()).toMatchObject({ format: 'jpeg', width: 72, height: 36 })
  expect(send).toHaveBeenCalledOnce()
  expect(destroy).toHaveBeenCalledOnce()
})

test('requires authentication and a JPEG in the latest scan', async () => {
  const { key, scanId } = scannedObject(200)
  expect((await call(key, scanId, false)).status).toBe(401)
  expect((await call('photos/unlisted.jpg', scanId)).status).toBe(404)
  scannedObject(200)
  expect((await call(key, scanId)).status).toBe(409)
  expect(send).not.toHaveBeenCalled()
})

test('rejects missing ETags and oversized images before downloading', async () => {
  const noEtag = scannedObject(200, null)
  expect((await call(noEtag.key, noEtag.scanId)).status).toBe(409)
  const oversized = scannedObject(128 * 1024 * 1024 + 1)
  expect((await call(oversized.key, oversized.scanId)).status).toBe(413)
  expect(send).not.toHaveBeenCalled()
})

test('reports a changed source and an invalid JPEG without returning the original bytes', async () => {
  const changed = scannedObject(200)
  send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
  expect((await call(changed.key, changed.scanId)).status).toBe(409)

  const invalid = Buffer.from('not-a-jpeg')
  const bad = scannedObject(invalid.length)
  send.mockResolvedValueOnce({ Body: Readable.from([invalid]), ContentLength: invalid.length, ETag: '"scanned"' })
  expect((await call(bad.key, bad.scanId)).status).toBe(422)
  expect(destroy).toHaveBeenCalledTimes(2)
})

test('limits concurrent downloads and releases slots after they finish', async () => {
  const original = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#ee7800' } }).jpeg().toBuffer()
  const { key, scanId } = scannedObject(original.length)
  const pending: Array<(value: unknown) => void> = []
  send.mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))

  const first = call(key, scanId)
  const second = call(key, scanId)
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  expect((await call(key, scanId)).status).toBe(429)
  for (const resolve of pending) resolve({ Body: Readable.from([original]), ContentLength: original.length, ETag: '"scanned"' })
  expect((await first).status).toBe(200)
  expect((await second).status).toBe(200)
  expect(destroy).toHaveBeenCalledTimes(2)
})
