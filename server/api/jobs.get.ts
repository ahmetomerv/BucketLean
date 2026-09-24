import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDatabase } from '../utils/db'
import { getJobSummary } from '../utils/jobs'
import { optimizationJobs } from '../utils/schema'
import { selectBucketId } from '../utils/buckets'

export default defineEventHandler((event) => {
  const bucketId = selectBucketId(getQuery(event).bucketId, true)
  if (!bucketId) return { jobs: [] }
  const db = getDatabase()
  const jobs = db.select({ id: optimizationJobs.id }).from(optimizationJobs).where(eq(optimizationJobs.bucketId, bucketId)).orderBy(desc(optimizationJobs.id)).limit(10).all()
  const blocked = db.select({ id: optimizationJobs.id }).from(optimizationJobs)
    .where(and(eq(optimizationJobs.bucketId, bucketId), inArray(optimizationJobs.status, ['needs_attention', 'paused']))).orderBy(desc(optimizationJobs.id)).all()
  const ids = [...blocked.map(job => job.id), ...jobs.filter(job => !blocked.some(blockedJob => blockedJob.id === job.id)).map(job => job.id)]
  return { jobs: ids.map(id => getJobSummary(id)) }
})
