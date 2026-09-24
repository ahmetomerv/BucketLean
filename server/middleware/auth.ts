import { timingSafeEqual } from 'node:crypto'

export default defineEventHandler((event) => {
  if (event.path === '/api/health') return
  const password = process.env.APP_PASSWORD
  if (!password) {
    throw createError({ statusCode: 503, statusMessage: 'APP_PASSWORD is required' })
  }
  const header = getHeader(event, 'authorization')
  const encoded = header?.match(/^Basic (.+)$/i)?.[1]
  let received = ''
  if (encoded) {
    try { received = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':') } catch { /* invalid header */ }
  }
  const a = Buffer.from(received)
  const b = Buffer.from(password)
  if (a.length === b.length && timingSafeEqual(a, b)) return
  setHeader(event, 'WWW-Authenticate', 'Basic realm="R2 JPEG Optimizer"')
  throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
})
