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
  return null
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
