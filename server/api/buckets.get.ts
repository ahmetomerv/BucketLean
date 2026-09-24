import { bucketSummaries } from '../utils/r2'

export default defineEventHandler(() => ({ buckets: bucketSummaries() }))
