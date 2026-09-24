import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createError, createRouter, defineEventHandler, getHeader, getQuery, getRouterParam,
  readBody, setHeader, setResponseStatus, toWebHandler } from 'h3'
import { getDatabase, closeDatabase } from '../utils/db'
import { objects, optimizationItems, optimizationJobs, scans } from '../utils/schema'

let dir: string
let request: ReturnType<typeof toWebHandler>
const originalPassword = process.env.APP_PASSWORD
const originalDatabasePath = process.env.DATABASE_PATH
const originalEndpoint = process.env.R2_ENDPOINT
const originalBucket = process.env.R2_BUCKET
const originalAccessKey = process.env.R2_ACCESS_KEY_ID
const originalSecretKey = process.env.R2_SECRET_ACCESS_KEY

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'r2-api-test-'))
  process.env.DATABASE_PATH = join(dir, 'test.sqlite')
  process.env.APP_PASSWORD = 'test:password'
  process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com'
  process.env.R2_BUCKET = 'test'
  // Nitro provides these H3 imports to route files at build time.
  for (const [name, value] of Object.entries({ createError, defineEventHandler, getHeader, getQuery,
    getRouterParam, readBody, setHeader, setResponseStatus })) vi.stubGlobal(name, value)
  const [auth, health, overview, listObjects, listJobs, jobDetail, createJob, createScan, reconcileJob, resumeJob] = await Promise.all([
    import('../middleware/auth'), import('./health.get'), import('./overview.get'), import('./objects.get'),
    import('./jobs.get'), import('./jobs/[id].get'), import('./jobs.post'), import('./scan.post'),
    import('./jobs/[id]/reconcile.post'),
    import('./jobs/[id]/resume.post'),
  ])
  const router = createRouter()
  router.get('/api/health', health.default)
  router.get('/api/overview', overview.default)
  router.get('/api/objects', listObjects.default)
  router.get('/api/jobs', listJobs.default)
  router.get('/api/jobs/:id', jobDetail.default)
  router.post('/api/jobs', createJob.default)
  router.post('/api/jobs/:id/reconcile', reconcileJob.default)
  router.post('/api/jobs/:id/resume', resumeJob.default)
  router.post('/api/scan', createScan.default)
  const app = createApp()
  app.use(auth.default)
  app.use(router.handler)
  request = toWebHandler(app)
})

afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH
  else process.env.DATABASE_PATH = originalDatabasePath
  if (originalPassword === undefined) delete process.env.APP_PASSWORD
  else process.env.APP_PASSWORD = originalPassword
  if (originalEndpoint === undefined) delete process.env.R2_ENDPOINT
  else process.env.R2_ENDPOINT = originalEndpoint
  if (originalBucket === undefined) delete process.env.R2_BUCKET
  else process.env.R2_BUCKET = originalBucket
  if (originalAccessKey === undefined) delete process.env.R2_ACCESS_KEY_ID
  else process.env.R2_ACCESS_KEY_ID = originalAccessKey
  if (originalSecretKey === undefined) delete process.env.R2_SECRET_ACCESS_KEY
  else process.env.R2_SECRET_ACCESS_KEY = originalSecretKey
  vi.unstubAllGlobals()
})

function call(path: string, options: { method?: string, body?: unknown, authorized?: boolean } = {}) {
  const headers: Record<string, string> = {}
  if (options.authorized !== false) headers.authorization = `Basic ${Buffer.from('user:test:password').toString('base64')}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return request(new Request(`http://localhost${path}`, { method: options.method ?? 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body) }))
}

test('health is public while data endpoints require the password', async () => {
  const health = await call('/api/health', { authorized: false })
  expect(health.status).toBe(200)
  expect(await health.json()).toMatchObject({ status: 'ok', database: 'ok' })
  const denied = await call('/api/objects', { authorized: false })
  expect(denied.status).toBe(401)
  expect(denied.headers.get('www-authenticate')).toContain('Basic')
  const allowed = await call('/api/objects')
  expect(allowed.status).toBe(200)
})

test('object filters and overview counts use the latest scan and a literal prefix', async () => {
  const db = getDatabase()
  const oldScan = db.insert(scans).values({ prefix: '', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  const scan = db.insert(scans).values({ prefix: '', status: 'completed', createdAt: new Date().toISOString() }).returning().get()
  const rows = [
    { key: 'photos/%-pending.jpg', scanId: scan.id, size: 200, isJpeg: true, isOptimized: false, metadataStatus: 'known' },
    { key: 'photos/%-done.jpeg', scanId: scan.id, size: 300, isJpeg: true, isOptimized: true, metadataStatus: 'known' },
    { key: 'photos/%-unknown.jpg', scanId: scan.id, size: 400, isJpeg: true, isOptimized: null, metadataStatus: 'unknown' },
    { key: 'photos/%-note.txt', scanId: scan.id, size: 500, isJpeg: false, isOptimized: null, metadataStatus: 'not_applicable' },
    { key: 'photos/other.jpg', scanId: scan.id, size: 600, isJpeg: true, isOptimized: false, metadataStatus: 'known' },
    { key: 'old.jpg', scanId: oldScan.id, size: 900, isJpeg: true, isOptimized: false, metadataStatus: 'known' },
  ] as const
  for (const row of rows) db.insert(objects).values({ ...row, discoveredAt: new Date().toISOString() }).run()
  const prefix = encodeURIComponent('photos/%-')
  const response = await call(`/api/objects?prefix=${prefix}&minBytes=250&status=optimized`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ total: 1, items: [{ key: 'photos/%-done.jpeg' }] })
  const unknown = await call(`/api/objects?prefix=${prefix}&status=unknown`)
  expect(await unknown.json()).toMatchObject({ total: 1, items: [{ key: 'photos/%-unknown.jpg' }] })
  const overview = await call(`/api/overview?prefix=${prefix}&minBytes=250`)
  expect(await overview.json()).toMatchObject({ scan: { id: scan.id }, totals: {
    objects: 4, jpegs: 3, jpegBytes: 900, optimized: 1, eligible: 0, metadataUnknown: 1,
  } })
})

test('rejects invalid filters, job settings, IDs and pages at the HTTP boundary', async () => {
  expect((await call('/api/objects?page=0')).status).toBe(400)
  expect((await call('/api/overview?minBytes=-1')).status).toBe(400)
  expect((await call('/api/objects?status=surprise')).status).toBe(400)
  expect((await call('/api/jobs/nope')).status).toBe(400)
  expect((await call('/api/jobs/123456')).status).toBe(404)
  expect((await call('/api/jobs', { method: 'POST', body: { minimumSavingPercent: 0 } })).status).toBe(400)
  expect((await call('/api/scan', { method: 'POST', body: { prefix: 12 } })).status).toBe(400)
})

test('lists persisted job summaries and paginates their item detail', async () => {
  const db = getDatabase()
  const job = db.insert(optimizationJobs).values({ status: 'completed', preset: 'balanced', createdAt: new Date().toISOString() }).returning().get()
  db.insert(optimizationItems).values({ jobId: job.id, key: 'one.jpg', originalSize: 100, optimizedSize: 70,
    status: 'completed', createdAt: new Date().toISOString() }).run()
  const list = await call('/api/jobs')
  expect(await list.json()).toMatchObject({ jobs: [{ total: 1, completed: 1, savedBytes: 30 }] })
  const detail = await call(`/api/jobs/${job.id}`)
  expect(await detail.json()).toMatchObject({ total: 1, items: [{ key: 'one.jpg' }], page: 1 })
  expect((await call(`/api/jobs/${job.id}?page=0`)).status).toBe(400)
  expect(await (await call(`/api/jobs/${job.id}?page=2`)).json()).toMatchObject({ items: [], page: 2 })
})

test('reconciliation routes validate state and unresolved jobs block new work', async () => {
  process.env.R2_ACCESS_KEY_ID = 'test'
  process.env.R2_SECRET_ACCESS_KEY = 'test'
  expect((await call('/api/jobs/nope/reconcile', { method: 'POST' })).status).toBe(400)
  expect((await call('/api/jobs/999999/reconcile', { method: 'POST' })).status).toBe(404)
  expect((await call('/api/jobs/nope/resume', { method: 'POST' })).status).toBe(400)
  expect((await call('/api/jobs/999999/resume', { method: 'POST' })).status).toBe(404)
  const db = getDatabase()
  const paused = db.insert(optimizationJobs).values({ status: 'paused', preset: 'balanced',
    pauseReason: 'credentials: Access denied', createdAt: new Date().toISOString() }).returning().get()
  expect((await call('/api/scan', { method: 'POST', body: { prefix: '' } })).status).toBe(409)
  expect((await call('/api/jobs', { method: 'POST', body: {} })).status).toBe(409)
  expect((await call(`/api/jobs/${paused.id}/resume`, { method: 'POST' })).status).toBe(202)
  const job = db.insert(optimizationJobs).values({ status: 'needs_attention', preset: 'balanced',
    createdAt: new Date().toISOString() }).returning().get()
  expect((await call('/api/scan', { method: 'POST', body: { prefix: '' } })).status).toBe(409)
  expect((await call('/api/jobs', { method: 'POST', body: {} })).status).toBe(409)
  expect((await call(`/api/jobs/${job.id}/reconcile`, { method: 'POST' })).status).toBe(409)
  expect((await call(`/api/jobs/${job.id}/resume`, { method: 'POST' })).status).toBe(409)
  for (let index = 0; index < 11; index++) db.insert(optimizationJobs).values({ status: 'completed', preset: 'balanced',
    createdAt: new Date().toISOString() }).run()
  const listed = await (await call('/api/jobs')).json() as { jobs: { job: { id: number, status: string } }[] }
  expect(listed.jobs).toHaveLength(11)
  expect(listed.jobs[0]?.job).toMatchObject({ id: job.id, status: 'needs_attention' })
})
