import { configuredBuckets } from '../../shared/r2-profiles.mjs'

export function selectBucketId(value: unknown, allowUnconfigured = false): string | null {
  const profiles = configuredBuckets()
  if (value === undefined || value === null || value === '') {
    if (!profiles.length && allowUnconfigured) return null
    if (!profiles.length) throw createError({ statusCode: 503, statusMessage: 'R2 connection is not configured' })
    if (profiles.length === 1) return profiles[0]!.id
    throw createError({ statusCode: 400, statusMessage: 'bucketId is required when multiple buckets are configured' })
  }
  if (typeof value !== 'string' || !profiles.some(profile => profile.id === value)) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown bucketId' })
  }
  return value
}
