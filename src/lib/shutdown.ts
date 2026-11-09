/**
 * Closes the app on SIGTERM or SIGINT so a deploy or restart lets requests in flight finish.
 * app.close() stops accepting connections (new requests get 503), waits for open requests,
 * then runs onClose hooks: the pool ends and the Redis client disconnects.
 * If that takes longer than timeoutMs the process exits with 1 anyway.
 */

export interface ClosableApp {
  close(): Promise<unknown>
  log: {
    info(object: object, message: string): void
    error(object: object, message: string): void
  }
}

export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown
}

export interface ShutdownOptions {
  signals?: readonly NodeJS.Signals[]
  timeoutMs?: number
  source?: SignalSource
  exit?: (code: number) => void
}

export const SHUTDOWN_TIMEOUT_MS = 10_000

/** Returns the shutdown function the signals call, so tests can await it. */
export function installGracefulShutdown(app: ClosableApp, options: ShutdownOptions = {}): (signal: string) => Promise<void> {
  const {
    signals = ['SIGTERM', 'SIGINT'],
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
    source = process,
    exit = (code: number) => process.exit(code),
  } = options
  let closing: Promise<void> | undefined

  const shutdown = (signal: string): Promise<void> => {
    closing ??= (async () => {
      app.log.info({ signal }, 'shutting down')
      const timer = setTimeout(() => {
        app.log.error({ signal, timeoutMs }, 'shutdown timed out')
        exit(1)
      }, timeoutMs)
      timer.unref?.()
      try {
        await app.close()
        clearTimeout(timer)
        exit(0)
      } catch (error) {
        clearTimeout(timer)
        app.log.error({ err: error }, 'shutdown failed')
        exit(1)
      }
    })()
    return closing
  }

  for (const signal of signals) {
    source.once(signal, () => {
      void shutdown(signal)
    })
  }
  return shutdown
}
