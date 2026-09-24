import { sql } from 'drizzle-orm'
import { getDatabase } from '../utils/db'
import { bucketSummaries } from '../utils/r2'

export default defineEventHandler(() => {
  getDatabase().run(sql`select 1`)
  return { status: 'ok', database: 'ok', r2Configured: bucketSummaries().length > 0 }
})
