/** @typedef {{ id: string, endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string }} R2Profile */

/** @param {NodeJS.ProcessEnv} env @returns {R2Profile[]} */
export function configuredBuckets(env = process.env) {
  /** @type {R2Profile[]} */
  const profiles = []
  const legacy = [env.R2_ENDPOINT, env.R2_BUCKET, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY]
  if (legacy.some(Boolean)) {
    if (!legacy.every(Boolean)) throw new Error('Complete all four legacy R2 environment variables')
    profiles.push({ id: 'default', endpoint: env.R2_ENDPOINT, bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY })
  }
  if (env.R2_BUCKETS_JSON) {
    let parsed
    try { parsed = JSON.parse(env.R2_BUCKETS_JSON) }
    catch { throw new Error('R2_BUCKETS_JSON must be a JSON array') }
    if (!Array.isArray(parsed)) throw new Error('R2_BUCKETS_JSON must be a JSON array')
    profiles.push(...parsed)
  }
  const ids = new Set()
  const identities = new Set()
  return profiles.map((profile) => {
    if (!profile || typeof profile !== 'object' ||
      typeof profile.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile.id) ||
      ![profile.endpoint, profile.bucket, profile.accessKeyId, profile.secretAccessKey]
        .every(value => typeof value === 'string' && value.length > 0)) {
      throw new Error('Each R2 bucket profile needs id, endpoint, bucket, accessKeyId, and secretAccessKey')
    }
    const endpoint = new URL(profile.endpoint)
    if (endpoint.protocol !== 'https:') throw new Error(`R2 endpoint for ${profile.id} must use HTTPS`)
    const identity = `${endpoint.toString()}\n${profile.bucket}`
    if (ids.has(profile.id) || identities.has(identity)) throw new Error('R2 bucket profile IDs and endpoint/bucket pairs must be unique')
    ids.add(profile.id)
    identities.add(identity)
    return { id: profile.id, endpoint: endpoint.toString(), bucket: profile.bucket,
      accessKeyId: profile.accessKeyId, secretAccessKey: profile.secretAccessKey }
  })
}

/** @param {string | undefined} id @param {NodeJS.ProcessEnv} env @returns {R2Profile} */
export function bucketConfig(id, env = process.env) {
  const profiles = configuredBuckets(env)
  if (!profiles.length) throw new Error('R2 connection is not configured')
  if (!id) {
    if (profiles.length !== 1) throw new Error('bucketId is required when multiple buckets are configured')
    return profiles[0]
  }
  const profile = profiles.find(profile => profile.id === id)
  if (!profile) throw new Error('R2 connection is not configured')
  return profile
}
