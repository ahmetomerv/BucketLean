import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const sourceDirectory = resolve('node_modules/mermaid/dist/chunks/mermaid.core')
const sourceFiles = await readdir(sourceDirectory)
let mermaidChunk
for (const file of sourceFiles.filter(file => file.endsWith('.mjs'))) {
  const source = await readFile(resolve(sourceDirectory, file), 'utf8')
  if (source.includes('from "fastdom"') && source.includes('from "fastdom/extensions/fastdom-promised.js"')) {
    mermaidChunk = resolve(sourceDirectory, file)
    break
  }
}
if (!mermaidChunk) throw new Error('Could not locate Mermaid fastdom imports')

const port = await new Promise((resolvePort, reject) => {
  const listener = createServer()
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', () => {
    const selected = listener.address().port
    listener.close(() => resolvePort(selected))
  })
})
const origin = `http://127.0.0.1:${port}`
const child = spawn(process.execPath, ['node_modules/vitepress/bin/vitepress.js', 'dev', 'docs', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString().slice(0, 2000) })

try {
  const deadline = Date.now() + 20000
  while (true) {
    if (child.exitCode !== null) throw new Error(`VitePress exited early: ${output}`)
    try {
      const response = await fetch(`${origin}/`)
      if (response.ok) break
    } catch { /* server still starting */ }
    if (Date.now() > deadline) throw new Error(`VitePress did not start: ${output}`)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }

  const response = await fetch(`${origin}/@fs${mermaidChunk}`)
  if (!response.ok) throw new Error(`Mermaid dev module returned ${response.status}`)
  const source = await response.text()
  for (const dependency of ['fastdom.js', 'fastdom_extensions_fastdom-promised__js.js']) {
    const path = source.match(new RegExp(`"(/\\.vitepress/cache/deps/${dependency.replaceAll('.', '\\.')}\\?[^\"]+)"`))?.[1]
    if (!path) throw new Error(`${dependency} was not prebundled for the dev browser`)
    const bundled = await fetch(`${origin}${path}`)
    if (!bundled.ok || !(await bundled.text()).includes('export')) throw new Error(`${dependency} has no usable browser module`)
  }
  console.log('VitePress dev smoke check passed: Mermaid CommonJS dependencies are prebundled')
} finally {
  child.kill('SIGTERM')
  await new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit()
    else child.once('exit', resolveExit)
  })
}
