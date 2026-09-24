import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

export function r2Config() {
  const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env
  if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 connection is not configured')
  }
  const endpoint = new URL(R2_ENDPOINT)
  if (endpoint.protocol !== 'https:') throw new Error('R2_ENDPOINT must use HTTPS')
  return { endpoint: endpoint.toString(), bucket: R2_BUCKET, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
}

export function createR2Client(config = r2Config()) {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
}

export { HeadObjectCommand, ListObjectsV2Command }
