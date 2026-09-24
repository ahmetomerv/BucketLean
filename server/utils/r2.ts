import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { bucketConfig, configuredBuckets } from '../../shared/r2-profiles.mjs'

export function r2Config(bucketId?: string) {
  return bucketConfig(bucketId)
}

export function bucketSummaries() {
  return configuredBuckets().map(({ id, endpoint, bucket }) => ({ id, endpoint, bucket }))
}

export function createR2Client(config = r2Config()) {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
}

export { HeadObjectCommand, ListObjectsV2Command }
