import { asc, desc, eq, sql } from 'drizzle-orm'
import { getDatabase } from '../utils/db'
import { objects, scans } from '../utils/schema'
import { objectConditions, parseFilters } from '../utils/query'
import { selectBucketId } from '../utils/buckets'

const pageSize = 10

export default defineEventHandler((event) => {
  const { prefix, minBytes, page, status } = parseFilters(getQuery(event))
  const bucketId = selectBucketId(getQuery(event).bucketId, true)
  const db = getDatabase()
  const scan = bucketId ? db.select({ id: scans.id }).from(scans).where(eq(scans.bucketId, bucketId)).orderBy(desc(scans.id)).get() : null
  if (!scan) return { items: [], total: 0, page, pageSize }
  const where = objectConditions(scan.id, prefix, minBytes, status, bucketId!)
  const total = db.select({ count: sql<number>`count(*)` }).from(objects).where(where).get()?.count ?? 0
  const items = db.select().from(objects).where(where).orderBy(asc(objects.key)).limit(pageSize).offset((page - 1) * pageSize).all()
  return { items, total, page, pageSize }
})
