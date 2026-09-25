import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'

export const MAX_IMAGE_BYTES = 128 * 1024 * 1024

export async function downloadToTempFile(client: Pick<S3Client, 'send'>, bucket: string, key: string,
  ifMatch?: string, options: { maxBytes?: number, temporaryDirectory?: string } = {}) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: ifMatch }))
  if (!result.Body) throw new Error(`R2 returned an empty body for ${key}`)
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  if (result.ContentLength != null && result.ContentLength > maxBytes) {
    if (result.Body instanceof Readable) result.Body.destroy()
    throw new Error('Image exceeds 128 MiB safety limit')
  }
  if (!(Symbol.asyncIterator in result.Body)) throw new Error('R2 response body is not streamable')
  const directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'bucketlean-download-'))
  const path = join(directory, 'object')
  let size = 0
  const hash = createHash('sha256')
  const limiter = new Transform({ transform(chunk: Buffer | Uint8Array | string, _encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.length > maxBytes - size) {
      callback(new Error('Image exceeds 128 MiB safety limit'))
      return
    }
    size += bytes.length
    hash.update(bytes)
    callback(null, bytes)
  } })
  try {
    const source = result.Body instanceof Readable ? result.Body : Readable.from(result.Body as AsyncIterable<Uint8Array>)
    await pipeline(source, limiter,
      createWriteStream(path, { mode: 0o600 }))
    if (result.ContentLength != null && size !== result.ContentLength) throw new Error('R2 download length mismatch')
    return { path, size, sha256: hash.digest('hex'), etag: result.ETag,
      dispose: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
