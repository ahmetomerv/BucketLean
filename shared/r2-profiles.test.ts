import { expect, test } from 'vitest'
import { bucketConfig, configuredBuckets } from './r2-profiles.mjs'

const profiles = [
  { id: 'photos', endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'photos', accessKeyId: 'shared-key', secretAccessKey: 'shared-secret' },
  { id: 'media', endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'media', accessKeyId: 'shared-key', secretAccessKey: 'shared-secret' },
  { id: 'private', endpoint: 'https://other.r2.cloudflarestorage.com', bucket: 'private', accessKeyId: 'restricted-key', secretAccessKey: 'restricted-secret' },
]

test('selects account-wide and bucket-scoped credentials by stable profile ID', () => {
  const env = { R2_BUCKETS_JSON: JSON.stringify(profiles) }
  expect(configuredBuckets(env)).toHaveLength(3)
  expect(bucketConfig('media', env)).toMatchObject({ bucket: 'media', accessKeyId: 'shared-key' })
  expect(bucketConfig('private', env)).toMatchObject({ bucket: 'private', accessKeyId: 'restricted-key' })
  expect(() => bucketConfig(undefined, env)).toThrow('bucketId is required')
  expect(() => bucketConfig('missing', env)).toThrow('R2 connection is not configured')
})

test('supports the legacy single-bucket environment and optional JSON profiles together', () => {
  const legacy = { R2_ENDPOINT: profiles[0]!.endpoint, R2_BUCKET: profiles[0]!.bucket,
    R2_ACCESS_KEY_ID: 'legacy-key', R2_SECRET_ACCESS_KEY: 'legacy-secret' }
  expect(bucketConfig(undefined, legacy)).toMatchObject({ id: 'default', accessKeyId: 'legacy-key' })
  expect(configuredBuckets({ ...legacy, R2_BUCKETS_JSON: JSON.stringify([profiles[1]]) }).map(profile => profile.id))
    .toEqual(['default', 'media'])
})

test('rejects ambiguous IDs, duplicate buckets, incomplete profiles, and insecure endpoints', () => {
  expect(() => configuredBuckets({ R2_BUCKETS_JSON: JSON.stringify([profiles[0], profiles[0]]) })).toThrow('unique')
  expect(() => configuredBuckets({ R2_BUCKETS_JSON: JSON.stringify([{ ...profiles[0]!, id: 'other' }, profiles[0]]) })).toThrow('unique')
  expect(() => configuredBuckets({ R2_BUCKETS_JSON: JSON.stringify([{ ...profiles[0]!, secretAccessKey: '' }]) })).toThrow('needs')
  expect(() => configuredBuckets({ R2_BUCKETS_JSON: JSON.stringify([{ ...profiles[0]!, endpoint: 'http://localhost' }]) })).toThrow('HTTPS')
  expect(() => configuredBuckets({ R2_ENDPOINT: profiles[0]!.endpoint })).toThrow('Complete all four')
})
