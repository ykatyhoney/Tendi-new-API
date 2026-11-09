import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installGracefulShutdown, type ClosableApp } from '../../src/lib/shutdown.js'

function fakeApp(close: () => Promise<unknown>): ClosableApp {
  return { close, log: { info: vi.fn(), error: vi.fn() } }
}

describe('graceful shutdown', () => {
  it('closes the app once and exits 0 on SIGTERM', async () => {
    const source = new EventEmitter()
    const close = vi.fn(async () => undefined)
    const exit = vi.fn()
    const shutdown = installGracefulShutdown(fakeApp(close), { source, exit })

    source.emit('SIGTERM')
    source.emit('SIGINT')
    await shutdown('SIGTERM')

    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits 1 when close fails', async () => {
    const exit = vi.fn()
    const shutdown = installGracefulShutdown(
      fakeApp(async () => {
        throw new Error('pool would not end')
      }),
      { source: new EventEmitter(), exit },
    )
    await shutdown('SIGINT')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits 1 when close takes longer than the timeout', async () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      const shutdown = installGracefulShutdown(fakeApp(() => new Promise(() => undefined)), {
        source: new EventEmitter(),
        exit,
        timeoutMs: 50,
      })
      void shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(60)
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
