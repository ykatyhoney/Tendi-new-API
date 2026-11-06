import { createHash } from 'node:crypto'

/** md5 hex of the raw token. This is the form stored in admin_api_tokens.token_hash. */
export function tokenHash(token: string): string {
  return createHash('md5').update(token).digest('hex')
}
