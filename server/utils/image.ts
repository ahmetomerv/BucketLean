import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import { InvalidJpegError } from './failures'

export const qualities = { archival: 90, balanced: 82, aggressive: 72 } as const
export type Preset = keyof typeof qualities

const requiredTags = [
  'DateTimeOriginal', 'Make', 'Model', 'LensMake', 'LensModel', 'Lens',
  'ISO', 'FNumber', 'ApertureValue', 'ExposureTime', 'ShutterSpeedValue',
  'FocalLength', 'FocalLengthIn35mmFormat', 'Orientation',
  'GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSLatitudeRef',
  'GPSLongitudeRef', 'GPSAltitudeRef', 'GPSDateStamp', 'GPSTimeStamp',
] as const

function sameTag(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function optimizeImage(input: Buffer, preset: Preset, preserveMetadata: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'r2-jpeg-'))
  try {
    const originalPath = join(dir, 'original.jpg')
    const optimizedPath = join(dir, 'optimized.jpg')
    await writeFile(originalPath, input)
    let before: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
    try { before = await sharp(input).metadata() }
    catch { throw new InvalidJpegError() }
    if (before.format !== 'jpeg' || !before.width || !before.height) throw new InvalidJpegError()
    try { await sharp(input, { failOn: 'error' }).stats() }
    catch { throw new InvalidJpegError() }
    const originalTags = await exiftool.read(originalPath) as Record<string, unknown>
    if (Array.isArray(originalTags.errors) && originalTags.errors.length) throw new Error(`Original metadata could not be read: ${originalTags.errors.join('; ')}`)

    const pipeline = sharp(input, { failOn: 'error' })
    if (preserveMetadata) pipeline.keepMetadata()
    const output = await pipeline.jpeg({ quality: qualities[preset], mozjpeg: true, progressive: true }).toBuffer()
    if (output[0] !== 0xff || output[1] !== 0xd8 || output.at(-2) !== 0xff || output.at(-1) !== 0xd9) throw new Error('Output JPEG markers are invalid')
    await writeFile(optimizedPath, output)
    const after = await sharp(output, { failOn: 'error' }).metadata()
    if (after.format !== 'jpeg' || before.width !== after.width || before.height !== after.height) throw new Error('Output JPEG dimensions changed')
    await sharp(output, { failOn: 'error' }).stats() // Decode every pixel, not only the header.
    const optimizedTags = await exiftool.read(optimizedPath) as Record<string, unknown>
    if (Array.isArray(optimizedTags.errors) && optimizedTags.errors.length) throw new Error(`Output metadata could not be read: ${optimizedTags.errors.join('; ')}`)

    if (preserveMetadata) {
      for (const tag of requiredTags) {
        if (originalTags[tag] != null && !sameTag(originalTags[tag], optimizedTags[tag])) throw new Error(`Required metadata changed: ${tag}`)
      }
      if (before.icc && (!after.icc || !before.icc.equals(after.icc))) throw new Error('ICC color profile changed')
    }
    return { output, width: after.width, height: after.height }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function stopExifTool() {
  await exiftool.end()
}
