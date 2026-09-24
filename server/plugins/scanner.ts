import { closeDatabase, getDatabase } from '../utils/db'
import { runNextScan, stopScanner } from '../utils/scanner'
import { runNextJob, stopJobWorker } from '../utils/jobs'
import { stopExifTool } from '../utils/image'
import { errorMessage, log } from '../utils/log'
import { workerLease } from '../utils/worker-lease'

export default defineNitroPlugin((nitroApp) => {
  getDatabase()
  void runNextScan()
  void runNextJob()
  const pollTimer = setInterval(() => { void runNextScan(); void runNextJob() }, 2000)
  pollTimer.unref()
  const leaseTimer = setInterval(() => {
    try { workerLease.renew() }
    catch (error) { log('error', 'worker_lease_renewal_failed', { error: errorMessage(error) }) }
  }, 2000)
  leaseTimer.unref()
  nitroApp.hooks.hook('close', async () => {
    clearInterval(pollTimer)
    await stopScanner()
    await stopJobWorker()
    clearInterval(leaseTimer)
    workerLease.release()
    await stopExifTool()
    closeDatabase()
  })
})
