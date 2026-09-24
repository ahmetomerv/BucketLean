import { afterAll, expect, test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import { optimizeImage, stopExifTool } from './image'

afterAll(async () => { await stopExifTool() })

test('MozJPEG output preserves dimensions, camera EXIF, and ICC profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r2-image-test-'))
  try {
    const path = join(dir, 'source.jpg')
    const source = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#cc9966' } })
      .withIccProfile('srgb').jpeg({ quality: 100 }).toBuffer()
    await writeFile(path, source)
    await exiftool.write(path, { Make: 'Test Camera', Model: 'Model One', LensModel: 'Test Lens',
      DateTimeOriginal: '2024:06:01 12:34:56', ISO: 400, FNumber: 2.8,
      ExposureTime: '1/125', FocalLength: 35, GPSLatitude: '48.1', GPSLatitudeRef: 'N',
      GPSLongitude: '11.5', GPSLongitudeRef: 'E', Orientation: 6 }, { writeArgs: ['-n'] })
    expect((await exiftool.read(path)).Orientation).toBe(6)
    expect((await exiftool.read(path)).GPSLatitude).toBeDefined()
    const input = await readFile(path)
    const optimized = await optimizeImage(input, 'balanced', true)
    expect(optimized.width).toBe(640)
    expect(optimized.height).toBe(480)
    expect(optimized.output.length).toBeLessThan(input.length)
    const outputPath = join(dir, 'result.jpg')
    await writeFile(outputPath, optimized.output)
    const tags = await exiftool.read(outputPath)
    expect(tags.Make).toBe('Test Camera')
    expect(tags.Model).toBe('Model One')
    expect(tags.LensModel).toBe('Test Lens')
    expect(tags.ISO).toBe(400)
    expect(tags.GPSLatitude).toBeDefined()
    expect(tags.GPSLongitude).toBeDefined()
    expect(tags.Orientation).toBe(6)
    expect(String(tags.DateTimeOriginal)).toContain('2024')
    expect((await sharp(optimized.output).metadata()).icc).toEqual((await sharp(input).metadata()).icc)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('rejects a non-JPEG input', async () => {
  await expect(optimizeImage(Buffer.from('not an image'), 'balanced', true)).rejects.toThrow()
})
