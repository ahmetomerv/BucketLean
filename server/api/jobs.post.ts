import { enqueueJob } from '../utils/jobs'
import { qualities, type Preset } from '../utils/image'
import { selectBucketId } from '../utils/buckets'

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)
  const prefix = body?.prefix ?? ''
  const minBytes = body?.minBytes ?? 1048576
  const preset = body?.preset ?? 'balanced'
  const minimumSavingPercent = body?.minimumSavingPercent ?? 15
  const preserveMetadata = body?.preserveMetadata ?? true
  const backupOriginals = body?.backupOriginals ?? true
  const deleteBackupAfterOptimization = body?.deleteBackupAfterOptimization ?? false
  const selectedKeys = body?.selectedKeys
  const scanId = body?.scanId
  if (typeof prefix !== 'string' || prefix.length > 1024 || !Number.isSafeInteger(minBytes) || (minBytes as number) < 0 ||
    typeof preset !== 'string' || !(preset in qualities) || !Number.isInteger(minimumSavingPercent) ||
    (minimumSavingPercent as number) < 1 || (minimumSavingPercent as number) > 99 ||
    typeof preserveMetadata !== 'boolean' || typeof backupOriginals !== 'boolean' ||
    typeof deleteBackupAfterOptimization !== 'boolean' ||
    (selectedKeys !== undefined && (!Array.isArray(selectedKeys) || selectedKeys.length < 1 || selectedKeys.length > 5000 ||
      selectedKeys.some(key => typeof key !== 'string' || !key.length || key.length > 1024) ||
      new Set(selectedKeys).size !== selectedKeys.length || !Number.isSafeInteger(scanId) || (scanId as number) < 1)) ||
    (selectedKeys === undefined && scanId !== undefined)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid job settings' })
  }
  const bucketId = selectBucketId(body?.bucketId)!
  try {
    const result = enqueueJob({ bucketId, prefix, minBytes: minBytes as number, preset: preset as Preset,
      minimumSavingPercent: minimumSavingPercent as number, preserveMetadata, backupOriginals,
      deleteBackupAfterOptimization, scanId: scanId as number | undefined, selectedKeys: selectedKeys as string[] | undefined })
    setResponseStatus(event, 202)
    return result
  } catch (error) {
    if (error instanceof Error && error.message === 'R2 connection is not configured') throw createError({ statusCode: 503, statusMessage: error.message })
    if (error instanceof Error) throw createError({ statusCode: 409, statusMessage: error.message })
    throw error
  }
})
