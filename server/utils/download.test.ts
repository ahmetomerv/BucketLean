import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { downloadToTempFile } from './download'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'r2-download-test-'))
  directories.push(directory)
  return directory
}

test('streams to a private temporary file and records size, hash, and ETag', async () => {
  const root = await fixtureDirectory()
  const client = { send: vi.fn(async (command: GetObjectCommand) => {
    expect(command.input).toMatchObject({ Bucket: 'test', Key: 'photo.jpg', IfMatch: '"old"' })
    return { Body: Readable.from([Buffer.from('hello'), Buffer.from(' world')]), ETag: '"old"', ContentLength: 11 }
  }) }
  const downloaded = await downloadToTempFile(client as never, 'test', 'photo.jpg', '"old"', { temporaryDirectory: root })
  expect(downloaded.size).toBe(11)
  expect(downloaded.sha256).toBe(createHash('sha256').update('hello world').digest('hex'))
  expect(await readFile(downloaded.path, 'utf8')).toBe('hello world')
  expect((await stat(downloaded.path)).mode & 0o777).toBe(0o600)
  await downloaded.dispose()
  expect(await readdir(root)).toEqual([])
})

test('stops an unannounced oversized body at the byte cap and cleans up', async () => {
  const root = await fixtureDirectory()
  const client = { send: vi.fn(async () => ({ Body: Readable.from([Buffer.alloc(5), Buffer.alloc(5)]) })) }
  await expect(downloadToTempFile(client as never, 'test', 'oversized.jpg', undefined,
    { maxBytes: 8, temporaryDirectory: root })).rejects.toThrow('Image exceeds 128 MiB safety limit')
  expect(await readdir(root)).toEqual([])
})

test('rejects an announced oversized body before writing a temporary file', async () => {
  const root = await fixtureDirectory()
  const body = Readable.from([Buffer.alloc(1)])
  const client = { send: vi.fn(async () => ({ Body: body, ContentLength: 9 })) }
  await expect(downloadToTempFile(client as never, 'test', 'oversized.jpg', undefined,
    { maxBytes: 8, temporaryDirectory: root })).rejects.toThrow('Image exceeds 128 MiB safety limit')
  expect(body.destroyed).toBe(true)
  expect(await readdir(root)).toEqual([])
})

test('rejects a length mismatch and removes the partial download', async () => {
  const root = await fixtureDirectory()
  const client = { send: vi.fn(async () => ({ Body: Readable.from([Buffer.from('short')]), ContentLength: 10 })) }
  await expect(downloadToTempFile(client as never, 'test', 'short.jpg', undefined,
    { temporaryDirectory: root })).rejects.toThrow('R2 download length mismatch')
  expect(await readdir(root)).toEqual([])
})
