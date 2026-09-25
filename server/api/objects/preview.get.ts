import { desc, eq, and } from 'drizzle-orm'
import sharp from 'sharp'
import { getDatabase } from '../../utils/db'
import { objects, scans } from '../../utils/schema'
import { createR2Client, r2Config } from '../../utils/r2'
import { selectBucketId } from '../../utils/buckets'
import { downloadToTempFile, MAX_IMAGE_BYTES } from '../../utils/download'

const PREVIEW_SIZE = 72
const MAX_CONCURRENT_PREVIEWS = 2
let activePreviews = 0

function remoteStatus(error: unknown) {
  return error && typeof error === 'object' && '$metadata' in error
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const bucketId = selectBucketId(query.bucketId)
  const key = query.key
  const scanId = Number(query.scanId)
  if (typeof key !== 'string' || !key || key.length > 1024 || !Number.isSafeInteger(scanId) || scanId < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid preview request' })
  }

  const db = getDatabase()
  const latestScan = db.select({ id: scans.id }).from(scans).where(eq(scans.bucketId, bucketId!)).orderBy(desc(scans.id)).get()
  if (!latestScan || latestScan.id !== scanId) throw createError({ statusCode: 409, statusMessage: 'Scan results changed; refresh the page' })
  const object = db.select().from(objects).where(and(eq(objects.bucketId, bucketId!), eq(objects.scanId, scanId), eq(objects.key, key), eq(objects.isJpeg, true))).get()
  if (!object) throw createError({ statusCode: 404, statusMessage: 'JPEG was not found in the latest scan' })
  if (!object.etag) throw createError({ statusCode: 409, statusMessage: 'JPEG has no scan ETag; rescan before previewing' })
  if (object.size > MAX_IMAGE_BYTES) throw createError({ statusCode: 413, statusMessage: 'JPEG exceeds the 128 MiB preview limit' })
  if (activePreviews >= MAX_CONCURRENT_PREVIEWS) throw createError({ statusCode: 429, statusMessage: 'Too many previews in progress; retry shortly' })

  const config = r2Config(bucketId!)
  const client = createR2Client(config)
  activePreviews++
  try {
    let downloaded: Awaited<ReturnType<typeof downloadToTempFile>>
    try {
      downloaded = await downloadToTempFile(client, config.bucket, key, object.etag)
    } catch (error) {
      if (remoteStatus(error) === 412) throw createError({ statusCode: 409, statusMessage: 'JPEG changed since the scan; rescan before previewing' })
      if (remoteStatus(error) === 404) throw createError({ statusCode: 404, statusMessage: 'JPEG no longer exists in R2' })
      if (error instanceof Error && error.message.includes('128 MiB safety limit')) throw createError({ statusCode: 413, statusMessage: 'JPEG exceeds the 128 MiB preview limit' })
      throw createError({ statusCode: 502, statusMessage: 'R2 preview download failed' })
    }

    try {
      if (downloaded.size !== object.size) throw createError({ statusCode: 409, statusMessage: 'JPEG size changed since the scan; rescan before previewing' })
      let thumbnail: Buffer
      try {
        const metadata = await sharp(downloaded.path, { limitInputPixels: 120_000_000 }).metadata()
        if (metadata.format !== 'jpeg') throw new Error('Not a JPEG')
        thumbnail = await sharp(downloaded.path, { limitInputPixels: 120_000_000, failOn: 'error' })
          .rotate().resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70 }).toBuffer()
      } catch {
        throw createError({ statusCode: 422, statusMessage: 'JPEG preview could not be decoded' })
      }
      setHeader(event, 'Content-Type', 'image/jpeg')
      setHeader(event, 'Cache-Control', 'private, no-store')
      setHeader(event, 'X-Content-Type-Options', 'nosniff')
      return thumbnail
    } finally {
      await downloaded.dispose()
    }
  } finally {
    client.destroy()
    activePreviews--
  }
})
