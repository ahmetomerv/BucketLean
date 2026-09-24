export function log(level: 'info' | 'error', event: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...details })
  if (level === 'error') console.error(line)
  else console.info(line)
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
