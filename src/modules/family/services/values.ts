export function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

export function asString(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  return String(value)
}

export function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return String(value)
}

export function contactName(fname: string, lname: string, legacyFullName: string): string {
  const joined = `${fname} ${lname}`.trim()
  return joined.length > 0 ? joined : legacyFullName
}

export function groupBy<T>(items: readonly T[], key: (item: T) => number): Map<number, T[]> {
  const grouped = new Map<number, T[]>()
  for (const item of items) {
    const id = key(item)
    const list = grouped.get(id)
    if (list === undefined) {
      grouped.set(id, [item])
    } else {
      list.push(item)
    }
  }
  return grouped
}
