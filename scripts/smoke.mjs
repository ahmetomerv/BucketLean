import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = await new Promise((resolve, reject) => {
  const listener = createServer()
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address()
    listener.close(() => resolve(address.port))
  })
})
const dir = await mkdtemp(join(tmpdir(), 'bucketlean-smoke-'))
const password = 'smoke-test-password'
const authorization = `Basic ${Buffer.from(`tester:${password}`).toString('base64')}`
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  env: { ...process.env, NODE_ENV: 'production', NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port),
    DATABASE_PATH: join(dir, 'optimizer.sqlite'), APP_PASSWORD: password,
    R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4000) })

async function request(path, options = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, options)
}

async function ready() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}):\n${output}`)
    try {
      const response = await request('/api/health')
      if (response.ok) return response
    } catch { /* wait for server startup */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Server did not become healthy:\n${output}`)
}

function assertStatus(response, status, path) {
  if (response.status !== status) throw new Error(`${path}: expected HTTP ${status}, received ${response.status}`)
}

try {
  const health = await ready()
  const healthBody = await health.json()
  if (healthBody.status !== 'ok' || healthBody.database !== 'ok' || healthBody.r2Configured !== false) {
    throw new Error(`Unexpected health response: ${JSON.stringify(healthBody)}`)
  }
  assertStatus(await request('/api/overview'), 401, '/api/overview without password')
  const headers = { authorization }
  assertStatus(await request('/api/overview', { headers }), 200, '/api/overview')
  const page = await request('/', { headers })
  assertStatus(page, 200, '/')
  const html = await page.text()
  if (!html.includes('>BucketLean</h1>')) throw new Error('Dashboard heading is missing')
  if (!html.includes('<title>BucketLean</title>')) throw new Error('Browser title is missing')
  for (const file of ['bucketlean-logo.svg', 'favicon-32.png', 'apple-touch-icon.png']) {
    if (!html.includes(`href="/${file}"`)) throw new Error(`Browser icon ${file} is missing from the page head`)
    const icon = await request(`/${file}`)
    assertStatus(icon, 200, `/${file}`)
    const bytes = Buffer.from(await icon.arrayBuffer())
    if (file.endsWith('.svg') ? !bytes.toString().includes('<svg') : !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`/${file} is not a valid ${file.endsWith('.svg') ? 'SVG' : 'PNG'}`)
    }
  }
  assertStatus(await request('/api/jobs', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ minimumSavingPercent: 0 }) }), 400, 'invalid /api/jobs')
  console.log('Production smoke check passed: health, auth, dashboard, and API validation')
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.kill('SIGTERM')
    })
  }
  await rm(dir, { recursive: true, force: true })
}
