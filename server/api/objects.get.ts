import { asc, desc, sql } from 'drizzle-orm'
import { getDatabase } from '../utils/db'
import { objects, scans } from '../utils/schema'
import { objectConditions, parseFilters } from '../utils/query'

export default defineEventHandler((event) => {
  const { prefix, minBytes, page, status } = parseFilters(getQuery(event))
  const db = getDatabase()
  const scan = db.select({ id: scans.id }).from(scans).orderBy(desc(scans.id)).get()
  if (!scan) return { items: [], total: 0, page, pageSize: 100 }
  const where = objectConditions(scan.id, prefix, minBytes, status)
  const total = db.select({ count: sql<number>`count(*)` }).from(objects).where(where).get()?.count ?? 0
  const items = db.select().from(objects).where(where).orderBy(asc(objects.key)).limit(100).offset((page - 1) * 100).all()
  return { items, total, page, pageSize: 100 }
})
