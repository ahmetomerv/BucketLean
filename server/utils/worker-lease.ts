import { randomUUID } from 'node:crypto'
import { getDatabaseConnection } from './db'

export class WorkerLeaseLostError extends Error {
  constructor() { super('Worker lease was lost; work will resume under the current owner') }
}

export function createWorkerLease(options: { owner?: string, durationMs?: number, now?: () => number } = {}) {
  const owner = options.owner ?? randomUUID()
  const durationMs = options.durationMs ?? 30_000
  const now = options.now ?? Date.now
  let held = false

  function tryAcquire() {
    const db = getDatabaseConnection()
    const claim = db.transaction(() => {
      const current = db.prepare('SELECT owner, expires_at FROM worker_lease WHERE name = ?').get('worker') as
        { owner: string, expires_at: number } | undefined
      const time = now()
      if (current && current.expires_at > time && current.owner !== owner) return false
      db.prepare(`INSERT INTO worker_lease (name, owner, expires_at) VALUES ('worker', ?, ?)
        ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`)
        .run(owner, time + durationMs)
      return true
    })
    held = claim.immediate()
    return held
  }

  function renew() {
    if (!held) return false
    try {
      const time = now()
      const result = getDatabaseConnection().prepare(`UPDATE worker_lease SET expires_at = ?
        WHERE name = 'worker' AND owner = ? AND expires_at > ?`).run(time + durationMs, owner, time)
      held = result.changes === 1
      return held
    } catch (error) {
      held = false
      throw error
    }
  }

  function assertOwned() {
    try {
      if (!renew()) throw new WorkerLeaseLostError()
    } catch (error) {
      if (error instanceof WorkerLeaseLostError) throw error
      throw new WorkerLeaseLostError()
    }
  }

  function release() {
    held = false
    getDatabaseConnection().prepare("DELETE FROM worker_lease WHERE name = 'worker' AND owner = ?").run(owner)
  }

  return { tryAcquire, renew, assertOwned, release }
}

export const workerLease = createWorkerLease()
