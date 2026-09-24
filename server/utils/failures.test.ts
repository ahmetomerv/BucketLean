import { expect, test } from 'vitest'
import { classifyFailure, retryDelayMs, SourceChangedError, InvalidJpegError } from './failures'

test('classifies service, network, source, and image failures without retrying permanent errors', () => {
  expect(classifyFailure({ $metadata: { httpStatusCode: 429 } })).toBe('throttled')
  expect(classifyFailure({ $metadata: { httpStatusCode: 503 } })).toBe('transient')
  expect(classifyFailure({ name: 'Error', code: 'ECONNRESET' })).toBe('transient')
  expect(classifyFailure(new Error('PUT failed', { cause: { $metadata: { httpStatusCode: 503 } } }))).toBe('transient')
  expect(classifyFailure({ $metadata: { httpStatusCode: 403 } })).toBe('credentials')
  expect(classifyFailure({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })).toBe('bucket')
  expect(classifyFailure({ $metadata: { httpStatusCode: 412 } })).toBe('source_changed')
  expect(classifyFailure(new SourceChangedError())).toBe('source_changed')
  expect(classifyFailure(new InvalidJpegError())).toBe('invalid_jpeg')
  expect(classifyFailure(new Error('Malformed metadata'))).toBe('permanent')
  expect([1, 2, 3, 10].map(retryDelayMs)).toEqual([2000, 4000, 8000, 30000])
})
