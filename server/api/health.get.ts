import { sql } from 'drizzle-orm'
import { getDatabase } from '../utils/db'

export default defineEventHandler(() => {
  getDatabase().run(sql`select 1`)
  return { status: 'ok', database: 'ok', r2Configured: Boolean(process.env.R2_ENDPOINT && process.env.R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) }
})
