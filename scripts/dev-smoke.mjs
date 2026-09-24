import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = await new Promise((resolve, reject) => {
  const listener = createServer()
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', () => {
    const selected = listener.address().port
    listener.close(() => resolve(selected))
  })
})
const dir = await mkdtemp(join(tmpdir(), 'r2-optimizer-dev-smoke-'))
const child = spawn(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, DATABASE_PATH: join(dir, 'optimizer.sqlite'), APP_PASSWORD: 'dev-smoke-password',
    R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKETS_JSON: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4000) })

try {
  const deadline = Date.now() + 30000
  while (true) {
    if (child.exitCode !== null) throw new Error(`Nuxt dev server exited early: ${output}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) {
        const health = await response.json()
        if (health.status !== 'ok' || health.database !== 'ok') throw new Error(`Unexpected health response: ${JSON.stringify(health)}`)
        break
      }
    } catch { /* server still starting */ }
    if (Date.now() > deadline) throw new Error(`Nuxt dev server did not become healthy: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  console.log('Nuxt dev smoke check passed: server imports and health route')
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
    })
  }
  await rm(dir, { recursive: true, force: true })
}
