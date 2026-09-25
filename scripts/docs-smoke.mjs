import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const root = resolve('docs/.vitepress/dist')
const base = process.env.DOCS_BASE || '/'
if (!base.startsWith('/') || !base.endsWith('/')) throw new Error('DOCS_BASE must start and end with /')

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  if (!pathname.startsWith(base)) {
    response.writeHead(404).end()
    return
  }
  let relative = pathname.slice(base.length)
  if (!relative || relative.endsWith('/')) relative += 'index.html'
  const path = resolve(root, relative)
  if (!path.startsWith(`${root}${sep}`)) {
    response.writeHead(404).end()
    return
  }
  try {
    const bytes = await readFile(path)
    response.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'application/octet-stream' }).end(bytes)
  } catch {
    response.writeHead(404).end()
  }
})

try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  const pages = [
    ['', 'BucketLean'],
    ['guide/getting-started.html', 'First safe run'],
    ['api/', 'HTTP API'],
    ['api/endpoints.html', 'Endpoint reference'],
    ['api/workflow.html', 'Automation workflow'],
    ['architecture.html', 'Architecture overview'],
    ['operations.html', 'Operations and recovery'],
  ]
  let home = ''
  for (const [page, expected] of pages) {
    const response = await fetch(`${origin}${base}${page}`)
    if (response.status !== 200) throw new Error(`${base}${page} returned ${response.status}`)
    const html = await response.text()
    if (!html.includes(expected)) throw new Error(`${base}${page} is missing ${expected}`)
    if (!page) home = html
  }
  if (!home.includes('href="https://github.com/ahmetomerv/BucketLean"')) throw new Error('Docs navigation is missing the GitHub repository link')
  const asset = home.match(new RegExp(`(?:href|src)="(${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}assets/[^"#?]+)`))?.[1]
  if (!asset) throw new Error('Home page has no local static asset')
  const assetResponse = await fetch(`${origin}${asset}`)
  if (assetResponse.status !== 200) throw new Error(`${asset} returned ${assetResponse.status}`)
  for (const file of ['bucketlean-logo.svg', 'favicon-32.png', 'apple-touch-icon.png']) {
    const iconPath = `${base}${file}`
    if (!home.includes(iconPath)) throw new Error(`Home page does not reference ${iconPath}`)
    const iconResponse = await fetch(`${origin}${iconPath}`)
    if (iconResponse.status !== 200) throw new Error(`${iconPath} returned ${iconResponse.status}`)
    const bytes = Buffer.from(await iconResponse.arrayBuffer())
    if (file.endsWith('.svg') ? !bytes.toString().includes('<svg') : !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`${iconPath} is not a valid ${file.endsWith('.svg') ? 'SVG' : 'PNG'}`)
    }
  }
  console.log(`Static docs smoke check passed at ${base}: ${pages.length} pages, an asset, and brand icons`)
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
}
