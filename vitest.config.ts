import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    passWithNoTests: true,
    include: ['test/**/*.test.ts'],
    // The whole suite sends a few hundred requests a minute from 127.0.0.1, and with REDIS_URL set every test
    // process adds to one shared per-IP count, so the default 300 a minute turned tests into 429s depending on
    // where the minute window fell. The rate-limit tests set their own limit, and env.test.ts ignores process.env.
    env: { RATE_LIMIT_PER_MINUTE: '100000' },
  },
})
