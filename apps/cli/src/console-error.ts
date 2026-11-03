/** An error with the HTTP status and code the console API answers with; shared so the config layer need not import the gateway. */
export class ConsoleError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message)
  }
}
