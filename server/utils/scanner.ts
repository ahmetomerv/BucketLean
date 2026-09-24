import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDatabase } from './db'
import { errorMessage, log } from './log'
import { createR2Client, HeadObjectCommand, ListObjectsV2Command, r2Config } from './r2'
import { objects, scans } from './schema'
import { workerLease, WorkerLeaseLostError } from './worker-lease'
import { claimWorkSlot, releaseWorkSlot } from './work-slot'

export function isJpegKey(key: string) {
  return /\.(jpe?g)$/i.test(key) && !key.startsWith('__optimizer/originals/')
}

let stopping = false
let active: Promise<void> | undefined

export function enqueueScan(prefix: string, bucketId?: string) {
  const config = r2Config(bucketId)
  const db = getDatabase()
  const existing = db.select().from(scans).where(and(eq(scans.bucketId, config.id), inArray(scans.status, ['queued', 'running']))).orderBy(asc(scans.id)).get()
  if (existing) return { scan: existing, created: false }
  const now = new Date().toISOString()
  const scan = db.insert(scans).values({ bucketId: config.id, prefix, status: 'queued', createdAt: now }).returning().get()
  log('info', 'scan_queued', { scanId: scan.id, bucketId: config.id, prefix })
  void runNextScan()
  return { scan, created: true }
}

export function runNextScan() {
  if (stopping || active) return active
  const db = getDatabase()
  const scan = db.select().from(scans).where(inArray(scans.status, ['queued', 'running'])).orderBy(asc(scans.id)).get()
  if (!scan) return
  if (!claimWorkSlot()) return
  try { if (!workerLease.tryAcquire()) { releaseWorkSlot(); return } }
  catch (error) {
    releaseWorkSlot()
    log('error', 'scan_lease_claim_failed', { error: errorMessage(error) })
    return
  }
  active = runScan(scan.id).catch((error) => {
    log('error', 'scan_worker_failed', { scanId: scan.id, error: errorMessage(error) })
  }).finally(() => { active = undefined; releaseWorkSlot() })
  return active
}

async function runScan(scanId: number) {
  const db = getDatabase()
  const scan = db.select().from(scans).where(eq(scans.id, scanId)).get()
  if (!scan) return
  let client: ReturnType<typeof createR2Client> | undefined
  try {
    const config = r2Config(scan.bucketId)
    client = createR2Client(config)
    workerLease.assertOwned()
    if (scan.status === 'running' && !scan.cursor) db.delete(objects).where(eq(objects.scanId, scanId)).run()
    db.update(scans).set({ status: 'running', startedAt: scan.startedAt ?? new Date().toISOString(), error: null }).where(eq(scans.id, scanId)).run()
    log('info', 'scan_started', { scanId, bucketId: scan.bucketId, prefix: scan.prefix })
    let cursor = scan.cursor ?? undefined
    do {
      if (stopping) return
      workerLease.assertOwned()
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: scan.prefix || undefined, ContinuationToken: cursor, MaxKeys: 1000 }))
      for (const item of page.Contents ?? []) {
        if (stopping) return
        workerLease.assertOwned()
        if (!item.Key) continue
        const jpeg = isJpegKey(item.Key)
        let optimized: boolean | null = null
        let optimizerVersion: string | null = null
        let metadataStatus: 'known' | 'unknown' | 'not_applicable' = jpeg ? 'unknown' : 'not_applicable'
        let metadataError: string | null = null
        if (jpeg) {
          try {
            const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: item.Key }))
            optimizerVersion = head.Metadata?.['image-optimizer-version'] ?? null
            optimized = optimizerVersion !== null
            metadataStatus = 'known'
          } catch (error) {
            metadataError = errorMessage(error)
            log('error', 'object_metadata_failed', { scanId, key: item.Key, error: metadataError })
          }
        }
        workerLease.assertOwned()
        db.insert(objects).values({
          bucketId: scan.bucketId, key: item.Key, scanId, etag: item.ETag ?? null, size: item.Size ?? 0,
          lastModified: item.LastModified?.toISOString() ?? null,
          isJpeg: jpeg, isOptimized: optimized, metadataStatus, metadataError,
          optimizerVersion, discoveredAt: new Date().toISOString(),
        }).onConflictDoUpdate({
          target: [objects.bucketId, objects.key],
          set: {
            scanId, etag: item.ETag ?? null, size: item.Size ?? 0,
            lastModified: item.LastModified?.toISOString() ?? null,
            isJpeg: jpeg, isOptimized: optimized, metadataStatus, metadataError,
            optimizerVersion, discoveredAt: new Date().toISOString(),
          },
        }).run()
      }
      if (page.IsTruncated && !page.NextContinuationToken) throw new Error('R2 returned a truncated page without a continuation token')
      workerLease.assertOwned()
      cursor = page.NextContinuationToken
      const counts = db.select({
        discovered: sql<number>`count(*)`,
        jpegs: sql<number>`coalesce(sum(case when ${objects.isJpeg} = 1 then 1 else 0 end), 0)`,
        errors: sql<number>`coalesce(sum(case when ${objects.metadataStatus} = 'unknown' then 1 else 0 end), 0)`,
      }).from(objects).where(eq(objects.scanId, scanId)).get()
      db.update(scans).set({
        cursor: cursor ?? null,
        discoveredCount: counts?.discovered ?? 0,
        jpegCount: counts?.jpegs ?? 0,
        metadataErrorCount: counts?.errors ?? 0,
      }).where(eq(scans.id, scanId)).run()
    } while (cursor)
    workerLease.assertOwned()
    db.update(scans).set({ status: 'completed', finishedAt: new Date().toISOString() }).where(eq(scans.id, scanId)).run()
    log('info', 'scan_completed', { scanId })
  } catch (error) {
    if (error instanceof WorkerLeaseLostError) {
      log('error', 'scan_lease_lost', { scanId })
      return
    }
    const message = errorMessage(error)
    db.update(scans).set({ status: 'failed', error: message, finishedAt: new Date().toISOString() }).where(eq(scans.id, scanId)).run()
    log('error', 'scan_failed', { scanId, error: message })
  } finally {
    client?.destroy()
  }
}

export async function stopScanner() {
  stopping = true
  await active
}
