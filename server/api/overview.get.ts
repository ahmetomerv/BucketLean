import { desc, eq, sql, and } from 'drizzle-orm'
import { getDatabase } from '../utils/db'
import { objects, scans } from '../utils/schema'
import { parseFilters, prefixCondition } from '../utils/query'
import { selectBucketId } from '../utils/buckets'

export default defineEventHandler((event) => {
  const filters = parseFilters(getQuery(event))
  const bucketId = selectBucketId(getQuery(event).bucketId, true)
  const db = getDatabase()
  const scan = bucketId ? db.select().from(scans).where(eq(scans.bucketId, bucketId)).orderBy(desc(scans.id)).get() : null
  if (!scan) return { scan: null, totals: { objects: 0, jpegs: 0, jpegBytes: 0, optimized: 0, eligible: 0, metadataUnknown: 0 } }
  const totals = db.select({
    objects: sql<number>`count(*)`,
    jpegs: sql<number>`coalesce(sum(case when ${objects.isJpeg} = 1 then 1 else 0 end), 0)`,
    jpegBytes: sql<number>`coalesce(sum(case when ${objects.isJpeg} = 1 then ${objects.size} else 0 end), 0)`,
    optimized: sql<number>`coalesce(sum(case when ${objects.isJpeg} = 1 and ${objects.isOptimized} = 1 then 1 else 0 end), 0)`,
    eligible: sql<number>`coalesce(sum(case when ${objects.isJpeg} = 1 and ${objects.isOptimized} = 0 and ${objects.size} >= ${filters.minBytes} then 1 else 0 end), 0)`,
    metadataUnknown: sql<number>`coalesce(sum(case when ${objects.isJpeg} = 1 and ${objects.metadataStatus} = 'unknown' then 1 else 0 end), 0)`,
  }).from(objects).where(and(eq(objects.bucketId, bucketId!), eq(objects.scanId, scan.id), prefixCondition(filters.prefix))).get()
  return { scan, totals: totals ?? { objects: 0, jpegs: 0, jpegBytes: 0, optimized: 0, eligible: 0, metadataUnknown: 0 } }
})
