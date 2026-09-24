import { desc, inArray } from 'drizzle-orm'
import { getDatabase } from '../utils/db'
import { getJobSummary } from '../utils/jobs'
import { optimizationJobs } from '../utils/schema'

export default defineEventHandler(() => {
  const db = getDatabase()
  const jobs = db.select({ id: optimizationJobs.id }).from(optimizationJobs).orderBy(desc(optimizationJobs.id)).limit(10).all()
  const blocked = db.select({ id: optimizationJobs.id }).from(optimizationJobs)
    .where(inArray(optimizationJobs.status, ['needs_attention', 'paused'])).orderBy(desc(optimizationJobs.id)).all()
  const ids = [...blocked.map(job => job.id), ...jobs.filter(job => !blocked.some(blockedJob => blockedJob.id === job.id)).map(job => job.id)]
  return { jobs: ids.map(id => getJobSummary(id)) }
})
