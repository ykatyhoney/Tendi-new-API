import { errorBody, type ApiErrorBody } from './api-error.js'

const PRIMARY_KEYS = new Set(['uq_fcp_primary', 'uq_fce_primary', 'uq_fca_primary'])
const TYPE_LABEL_CHECKS = new Set(['chk_fcp_type_label', 'chk_fce_type_label', 'chk_fca_type_label'])

interface DatabaseErrorLike {
  errno?: unknown
  sqlMessage?: unknown
  message?: unknown
}

/** Maps a MariaDB failure to the API error body. Returns null when the error is not one of the known constraints. */
export function mapDatabaseError(error: unknown): ApiErrorBody | null {
  if (!isDatabaseError(error)) {
    return null
  }
  const errno = Number(error.errno)
  const constraint = constraintName(error)
  if (errno === 1062 && constraint !== undefined && PRIMARY_KEYS.has(constraint)) {
    return errorBody(409, 'SECOND_PRIMARY', 'This contact already has a primary value of this kind.', {
      constraint,
    })
  }
  if (errno === 1062 && constraint === 'uniq_fm') {
    return errorBody(409, 'ALREADY_MEMBER', 'This contact is already a member of the household.', {
      constraint,
    })
  }
  if (errno === 1062 && constraint === 'uniq_fmc') {
    return errorBody(409, 'DUPLICATE_RIGHTS', 'This member already has rights for this child.', {
      constraint,
    })
  }
  if (errno === 4025 && constraint !== undefined && TYPE_LABEL_CHECKS.has(constraint)) {
    return errorBody(400, 'TYPE_LABEL_NOT_ALLOWED', 'A name is allowed only when the type is other.', {
      constraint,
    })
  }
  if (errno === 1452 && constraint === 'fk_fm_relationship') {
    return errorBody(400, 'UNKNOWN_RELATIONSHIP', 'The relationship is not in the list.', { constraint })
  }
  if (errno === 1451) {
    return errorBody(409, 'IN_USE', 'This record is still in use.', {
      ...(constraint === undefined ? {} : { constraint }),
    })
  }
  const invalid = INVALID_VALUE_ERRORS.get(errno)
  if (invalid !== undefined) {
    // The message names the column only. MariaDB's text can quote the rejected value, so it is not passed on.
    const column = columnName(error)
    return errorBody(400, 'VALIDATION', invalid, [
      { path: column === undefined ? '/' : `/${column}`, message: invalid },
    ])
  }
  return null
}

/**
 * A value the schema let through but the column refused. These are 400s, not server errors.
 * The request schemas should catch them first; this is the backstop.
 */
const INVALID_VALUE_ERRORS = new Map<number, string>([
  [1048, 'A required value is missing.'],
  [1264, 'A number is out of range.'],
  [1265, 'A value does not fit its column.'],
  [1366, 'A value has characters or a format the column cannot store.'],
  [1406, 'A value is too long.'],
])

/** `column 'name'` (1048, 1264, 1265, 1406) or `column \`db\`.\`table\`.\`name\`` (1366). */
function columnName(error: DatabaseErrorLike): string | undefined {
  const message = typeof error.sqlMessage === 'string' ? error.sqlMessage : ''
  const quoted = message.match(/column '([A-Za-z0-9_]+)'/i)
  if (quoted?.[1] !== undefined) {
    return quoted[1]
  }
  const qualified = message.match(/column ((?:`[A-Za-z0-9_]+`\.?)+)/)
  return qualified?.[1]?.split('.').pop()?.replaceAll('`', '')
}

function isDatabaseError(error: unknown): error is DatabaseErrorLike {
  return typeof error === 'object' && error !== null && 'errno' in error && Number.isFinite(Number(error.errno))
}

function constraintName(error: DatabaseErrorLike): string | undefined {
  const message = typeof error.sqlMessage === 'string' ? error.sqlMessage : ''
  const key = message.match(/for key '([^']+)'/)
  if (key?.[1] !== undefined) {
    const name = key[1].split('.').pop()
    return name === undefined || name.length === 0 ? undefined : name
  }
  const constraint = message.match(/CONSTRAINT [`']([^`']+)[`']/)
  return constraint?.[1]
}
