/** A LIKE pattern that matches the value anywhere, with % and _ treated as text. */
export function likeContains(value: string): string {
  const escaped = value.replace(/[\\%_]/g, (character) => `\\${character}`)
  return `%${escaped}%`
}
