// Shared pieces of the family route definitions.

import Type from 'typebox';

/** Every family route carries this OpenAPI tag. */
export const FAMILY_TAG = 'family';

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request (schema or business rule)',
  401: 'Missing, unknown or inactive staff token',
  403: 'Staff type not allowed to use the Family API',
  404: 'Not found',
  409: 'Conflicts with the current data',
};

/** Response entries for these status codes, all in the { statusCode, error, message } format. */
export function errorResponses(...codes: number[]) {
  return Object.fromEntries(
    codes.map((code) => [code, Type.Ref('ErrorResponse', { description: ERROR_DESCRIPTIONS[code] ?? 'Error' })]),
  );
}

export const READ_ERRORS = [400, 401, 403, 404];
export const WRITE_ERRORS = [400, 401, 403, 404, 409];
