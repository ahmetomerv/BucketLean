import { closeDatabase, getDatabase } from '../utils/db'
import { runNextScan, stopScanner } from '../utils/scanner'
import { runNextJob, stopJobWorker } from '../utils/jobs'
import { stopExifTool } from '../utils/image'

export default defineNitroPlugin((nitroApp) => {
  getDatabase()
  void runNextScan()
  void runNextJob()
  const timer = setInterval(() => { void runNextScan(); void runNextJob() }, 2000)
  timer.unref()
  nitroApp.hooks.hook('close', async () => {
    clearInterval(timer)
    await stopScanner()
    await stopJobWorker()
    await stopExifTool()
    closeDatabase()
  })
})
