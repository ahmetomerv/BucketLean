let occupied = false

export function claimWorkSlot() {
  if (occupied) return false
  occupied = true
  return true
}

export function releaseWorkSlot() { occupied = false }
