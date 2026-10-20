// Database errors that mean "conflicts with the current data" become 409 with a readable message,
// instead of the generic 500:
//   * SIGNAL from the mirror procedures (errno 1644, SQLSTATE 45000): their MESSAGE_TEXT is written
//     for people, e.g. "Family value too long for children_additional_information.father_email
//     (150), child 12", so it is passed on as is.
//   * Foreign keys (1451 a row is still referenced, 1452 the referenced row is gone), for example a
//     member removed by a concurrent request.
//   * Unique keys (1062), for example a rights row (uniq_fmc) inserted by a concurrent request.
// Anything else is rethrown unchanged.

import { HttpError } from '../../../errors.ts';

const ER_DUP_ENTRY = 1062;
const ER_ROW_IS_REFERENCED_2 = 1451;
const ER_NO_REFERENCED_ROW_2 = 1452;
const ER_SIGNAL_EXCEPTION = 1644;

interface DbError {
  errno?: number;
  sqlMessage?: string;
}

const constraintOf = (message: string) => /CONSTRAINT `([^`]+)`/.exec(message)?.[1];
const keyOf = (message: string) => /for key '([^']+)'/.exec(message)?.[1];

/** The 409 for a conflict-type database error, or null for any other error. */
export function dbConflict(error: unknown): HttpError | null {
  const { errno, sqlMessage = '' } = (error ?? {}) as DbError;
  switch (errno) {
    case ER_SIGNAL_EXCEPTION:
      return new HttpError(409, sqlMessage || 'The database refused the change');
    case ER_NO_REFERENCED_ROW_2:
      return new HttpError(
        409,
        `The change refers to a row that no longer exists (${constraintOf(sqlMessage) ?? 'foreign key'}); reload and try again`,
      );
    case ER_ROW_IS_REFERENCED_2:
      return new HttpError(
        409,
        `The row is still referenced by other data (${constraintOf(sqlMessage) ?? 'foreign key'})`,
      );
    case ER_DUP_ENTRY:
      return new HttpError(
        409,
        `A concurrent change created the same row (${keyOf(sqlMessage) ?? 'unique key'}); reload and try again`,
      );
    default:
      return null;
  }
}

/** Runs `work`, turning conflict-type database errors into 409 (dbConflict). */
export async function conflictsAs409<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw dbConflict(error) ?? error;
  }
}
