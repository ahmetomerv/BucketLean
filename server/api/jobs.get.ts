import { desc, eq } from 'drizzle-orm'
import { getDatabase } from '../utils/db'
import { getJobSummary } from '../utils/jobs'
import { optimizationJobs } from '../utils/schema'

export default defineEventHandler(() => {
  const db = getDatabase()
  const jobs = db.select({ id: optimizationJobs.id }).from(optimizationJobs).orderBy(desc(optimizationJobs.id)).limit(10).all()
  const attention = db.select({ id: optimizationJobs.id }).from(optimizationJobs)
    .where(eq(optimizationJobs.status, 'needs_attention')).orderBy(desc(optimizationJobs.id)).get()
  const ids = attention && !jobs.some(job => job.id === attention.id)
    ? [attention.id, ...jobs.map(job => job.id)] : jobs.map(job => job.id)
  return { jobs: ids.map(id => getJobSummary(id)) }
})
