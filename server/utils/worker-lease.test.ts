import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, getDatabaseConnection } from './db'
import { createWorkerLease, WorkerLeaseLostError } from './worker-lease'

let dir: string
const previous = { DATABASE_PATH: process.env.DATABASE_PATH, R2_ENDPOINT: process.env.R2_ENDPOINT, R2_BUCKET: process.env.R2_BUCKET }
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'r2-lease-test-'))
  process.env.DATABASE_PATH = join(dir, 'test.sqlite')
  process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com'
  process.env.R2_BUCKET = 'test'
})
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('only one owner can hold the durable lease; expiry permits takeover and fences the old owner', () => {
  let time = 1_000
  const first = createWorkerLease({ owner: 'first', durationMs: 100, now: () => time })
  const second = createWorkerLease({ owner: 'second', durationMs: 100, now: () => time })
  expect(first.tryAcquire()).toBe(true)
  expect(second.tryAcquire()).toBe(false)
  time = 1_050
  expect(first.renew()).toBe(true)
  time = 1_120
  expect(second.tryAcquire()).toBe(false)
  time = 1_151
  expect(second.tryAcquire()).toBe(true)
  expect(() => first.assertOwned()).toThrow(WorkerLeaseLostError)
  first.release()
  expect(getDatabaseConnection().prepare("SELECT owner FROM worker_lease WHERE name = 'worker'").get()).toEqual({ owner: 'second' })
  expect(second.renew()).toBe(true)
  second.release()
  expect(first.tryAcquire()).toBe(true)
  first.release()
})
