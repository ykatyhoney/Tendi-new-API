export interface SchemaSnapshot {
  columns: string[]
  indexes: string[]
  foreignKeys: string[]
  checks: string[]
  lockTriggers: string[]
}

const KEYS = ['columns', 'indexes', 'foreignKeys', 'checks', 'lockTriggers'] as const

export function diffSchema(actual: SchemaSnapshot, reference: SchemaSnapshot): string[] {
  const differences: string[] = []
  for (const key of KEYS) {
    const actualSet = new Set(actual[key])
    const referenceSet = new Set(reference[key])
    for (const item of reference[key]) {
      if (!actualSet.has(item)) {
        differences.push(`missing ${key}: ${item}`)
      }
    }
    for (const item of actual[key]) {
      if (!referenceSet.has(item)) {
        differences.push(`extra ${key}: ${item}`)
      }
    }
  }
  return differences
}
