import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const logo = await readFile(resolve('public/bucketlean-logo.svg'))
const favicon = await sharp(logo, { density: 144 }).resize(32, 32).png().toBuffer()
const touchMark = await sharp(logo, { density: 288 }).resize(160, 160).png().toBuffer()
const touchIcon = await sharp({
  create: { width: 180, height: 180, channels: 4, background: '#fff7ed' },
}).composite([{ input: touchMark, left: 10, top: 10 }]).png().toBuffer()

for (const directory of ['public', 'docs/public']) {
  if (directory !== 'public') await writeFile(resolve(directory, 'bucketlean-logo.svg'), logo)
  await writeFile(resolve(directory, 'favicon-32.png'), favicon)
  await writeFile(resolve(directory, 'apple-touch-icon.png'), touchIcon)
}

console.log('BucketLean logo and browser icons generated for the app and docs')
