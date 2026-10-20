// Children search (GET /children?q=), for picking the child to link (the Link child screen).
// Read-only; it never changes children.

import { HttpError } from '../../../errors.ts';
import type { FamilyDb } from '../db.ts';
import { type ChildSearch, searchChildren as searchChildRows } from '../repository/children.ts';

/** Shortest name `q` (after trimming); an id may be a single digit. */
export const MIN_CHILD_SEARCH_LENGTH = 2;

/** Digits only (an int(11) id, any length): that child; otherwise a name of 2 or more characters. */
export function childSearch(q: string): ChildSearch {
  if (/^\d+$/.test(q) && Number(q) <= 2147483647) return { id: Number(q) };
  if (q.length < MIN_CHILD_SEARCH_LENGTH) {
    throw new HttpError(
      400,
      `querystring/q must have at least ${MIN_CHILD_SEARCH_LENGTH} characters other than spaces`,
    );
  }
  return { name: q };
}

export async function searchChildren(db: FamilyDb, query: { q: string; page?: number; pageSize?: number }) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const { rows, total } = await searchChildRows(db.pool, childSearch(query.q.trim()), pageSize, (page - 1) * pageSize);
  return { items: rows, total, page, page_size: pageSize };
}
