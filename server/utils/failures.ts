export type FailureKind = 'transient' | 'throttled' | 'credentials' | 'bucket' | 'source_changed' | 'invalid_jpeg' | 'permanent'

export class InvalidJpegError extends Error {
  constructor() { super('Input is not a valid JPEG') }
}

export class SourceChangedError extends Error {
  constructor(message = 'Source changed since the scan') { super(message) }
}

export function classifyFailure(error: unknown): FailureKind {
  if (error instanceof SourceChangedError) return 'source_changed'
  if (error instanceof InvalidJpegError) return 'invalid_jpeg'
  if (!error || typeof error !== 'object') return 'permanent'
  const value = error as { name?: string, code?: string, message?: string, cause?: unknown,
    $metadata?: { httpStatusCode?: number } }
  const status = value.$metadata?.httpStatusCode
  const codes = [value.name, value.code]
  const hasCode = (known: string[]) => codes.some(code => code != null && known.includes(code))
  if (status === 412) return 'source_changed'
  if (status === 404 && hasCode(['NoSuchKey', 'NotFound'])) return 'source_changed'
  if (hasCode(['NoSuchBucket', 'InvalidBucketName', 'PermanentRedirect'])) return 'bucket'
  if (status === 401 || status === 403 || hasCode(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
    'ExpiredToken', 'InvalidToken', 'AuthorizationHeaderMalformed'])) return 'credentials'
  if (status === 429 || hasCode(['SlowDown', 'Throttling', 'ThrottlingException', 'TooManyRequestsException'])) return 'throttled'
  if (status === 408 || (status != null && status >= 500 && status <= 599)) return 'transient'
  if (hasCode(['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'ECONNRESET', 'ETIMEDOUT',
    'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])) return 'transient'
  if (/timed out|connection reset|socket hang up/i.test(value.message ?? '')) return 'transient'
  return value.cause ? classifyFailure(value.cause) : 'permanent'
}

export const MAX_TRANSIENT_FAILURES = 3
export function retryDelayMs(transientFailures: number) {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, transientFailures - 1))
}
