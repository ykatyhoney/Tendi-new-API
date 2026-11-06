export const LOCAL_DB_HOSTS = new Set(['127.0.0.1', 'localhost'])

export const RESET_DATABASES = {
  dev: 'tendi_family_dev',
  test: 'tendi_family_test',
} as const

export type ResetTarget = keyof typeof RESET_DATABASES

const ALLOWED_DATABASES = new Set<string>([
  ...Object.values(RESET_DATABASES),
  'tendi_family_schema_ref',
])

export function assertLocalHost(host: string): void {
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(`Refusing database host ${host}. Only 127.0.0.1 and localhost are allowed.`)
  }
}

export function databaseNameForTarget(target: string): (typeof RESET_DATABASES)[ResetTarget] {
  if (target === 'dev' || target === 'test') {
    return RESET_DATABASES[target]
  }
  throw new Error(`--target must be dev or test. Got ${target}.`)
}

export function assertAllowedDatabase(name: string): void {
  if (!ALLOWED_DATABASES.has(name)) {
    throw new Error(
      `Refusing database ${name}. Allowed names are tendi_family_dev, tendi_family_test, and tendi_family_schema_ref.`,
    )
  }
}
