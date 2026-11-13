export function normalized(value: string): string {
  return value.trim().toLowerCase()
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}
