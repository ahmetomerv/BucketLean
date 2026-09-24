import { desc } from 'drizzle-orm'
import { getDatabase } from '../utils/db'
import { getJobSummary } from '../utils/jobs'
import { optimizationJobs } from '../utils/schema'

export default defineEventHandler(() => {
  const db = getDatabase()
  const jobs = db.select({ id: optimizationJobs.id }).from(optimizationJobs).orderBy(desc(optimizationJobs.id)).limit(10).all()
  return { jobs: jobs.map(job => getJobSummary(job.id)) }
})
