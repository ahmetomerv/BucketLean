import { and, eq, sql, type SQL } from 'drizzle-orm'
import { objects } from './schema'

export function parseFilters(query: Record<string, unknown>) {
  const prefix = typeof query.prefix === 'string' ? query.prefix : ''
  const minBytes = Number(query.minBytes ?? 0)
  const page = Number(query.page ?? 1)
  const status = typeof query.status === 'string' ? query.status : 'all'
  if (prefix.length > 1024 || !Number.isSafeInteger(minBytes) || minBytes < 0 || !Number.isSafeInteger(page) || page < 1 || !['all', 'optimized', 'not_optimized', 'unknown'].includes(status)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid filters' })
  }
  return { prefix, minBytes, page, status }
}

export function prefixCondition(prefix: string): SQL | undefined {
  return prefix ? sql`substr(${objects.key}, 1, ${prefix.length}) = ${prefix}` : undefined
}

export function objectConditions(scanId: number, prefix: string, minBytes: number, status: string, bucketId: string) {
  return and(
    eq(objects.bucketId, bucketId),
    eq(objects.scanId, scanId),
    eq(objects.isJpeg, true),
    prefixCondition(prefix),
    sql`${objects.size} >= ${minBytes}`,
    status === 'optimized' ? eq(objects.isOptimized, true) : undefined,
    status === 'not_optimized' ? eq(objects.isOptimized, false) : undefined,
    status === 'unknown' ? eq(objects.metadataStatus, 'unknown') : undefined,
  )
}
