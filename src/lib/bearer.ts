/** The token from `Authorization: Bearer <token>`, or undefined when the header is absent or not a bearer token. */
export function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (match === null) {
    return undefined
  }
  return match[1]
}
