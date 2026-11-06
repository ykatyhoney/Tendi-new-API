/** Quote a schema, table, or column name. Rejects anything that is not a plain identifier. */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing identifier ${name}.`)
  }
  return `\`${name}\``
}
