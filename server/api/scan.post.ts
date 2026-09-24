import { enqueueScan } from '../utils/scanner'
import { getDatabase } from '../utils/db'
import { optimizationJobs } from '../utils/schema'
import { inArray } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prefix?: unknown }>(event)
  if (body?.prefix !== undefined && typeof body.prefix !== 'string') throw createError({ statusCode: 400, statusMessage: 'Prefix must be a string' })
  const prefix = (body?.prefix ?? '') as string
  if (prefix.length > 1024) throw createError({ statusCode: 400, statusMessage: 'Invalid prefix' })
  const activeJob = getDatabase().select({ id: optimizationJobs.id }).from(optimizationJobs)
    .where(inArray(optimizationJobs.status, ['queued', 'running', 'paused', 'needs_attention'])).get()
  if (activeJob) throw createError({ statusCode: 409, statusMessage: 'Resolve the optimization job before scanning' })
  try {
    const result = enqueueScan(prefix)
    setResponseStatus(event, result.created ? 202 : 200)
    return { scan: result.scan, created: result.created }
  } catch (error) {
    if (error instanceof Error && error.message === 'R2 connection is not configured') throw createError({ statusCode: 503, statusMessage: error.message })
    throw error
  }
})
