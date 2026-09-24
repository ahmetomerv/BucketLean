import { and, asc, eq } from 'drizzle-orm'
import { getDatabase } from '../../utils/db'
import { getJobSummary } from '../../utils/jobs'
import { optimizationItems } from '../../utils/schema'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 400, statusMessage: 'Invalid job ID' })
  const summary = getJobSummary(id)
  if (!summary) throw createError({ statusCode: 404, statusMessage: 'Job not found' })
  const page = Number(getQuery(event).page ?? 1)
  if (!Number.isSafeInteger(page) || page < 1) throw createError({ statusCode: 400, statusMessage: 'Invalid page' })
  const items = getDatabase().select().from(optimizationItems).where(eq(optimizationItems.jobId, id))
    .orderBy(asc(optimizationItems.id)).limit(100).offset((page - 1) * 100).all()
  return { ...summary, items, page, pageSize: 100 }
})
