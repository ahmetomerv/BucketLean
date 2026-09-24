import { resumeJob } from '../../../utils/jobs'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 400, statusMessage: 'Invalid job ID' })
  try {
    const result = resumeJob(id)
    setResponseStatus(event, 202)
    return result
  } catch (error) {
    if (error instanceof Error && error.message === 'Job not found') throw createError({ statusCode: 404, statusMessage: error.message })
    if (error instanceof Error && error.message === 'R2 connection is not configured') throw createError({ statusCode: 503, statusMessage: error.message })
    if (error instanceof Error) throw createError({ statusCode: 409, statusMessage: error.message })
    throw error
  }
})
