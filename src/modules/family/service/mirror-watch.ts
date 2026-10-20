// The warning a write returns when it changed the legacy parent values of linked children.
//
// The mirror triggers rewrite the 28 legacy columns of every linked child a family-table write can
// reach, inside the same transaction. So a write takes a snapshot of those columns for the
// candidate children (the linked children of the families involved) after taking its locks and
// before changing anything, and compares after its changes: affected_child_ids are the children
// whose legacy values actually changed. An edit the mirror does not use (a note, a billing
// address, a hebrew_name) changes nothing and returns no warning.

import type { Queryable } from '../db.ts';
import { legacySnapshot } from '../repository/legacy.ts';

export interface MirrorWarning {
  message: string;
  affected_child_ids: number[];
}

/** Snapshot `childIds` now; `changed()` gives those whose 28 mirrored values differ since. */
export async function watchLegacy(db: Queryable, childIds: number[]): Promise<{ changed(): Promise<number[]> }> {
  const before = await legacySnapshot(db, childIds);
  return {
    async changed() {
      const after = await legacySnapshot(db, childIds);
      return childIds.filter((id) => before.get(id) !== after.get(id));
    },
  };
}

/**
 * The response body, with `warning` when linked children's legacy values changed. Called after the
 * transaction committed.
 */
export function withMirrorWarning<T extends object>(body: T, affected: number[]): T & { warning?: MirrorWarning } {
  // invalidateChildCaches(affected) belongs here once it exists: none is needed today
  // (docs/CONTEXT.md, "Invalidation").
  if (affected.length === 0) return body;
  return {
    ...body,
    warning: {
      message: `The parent details the legacy app shows changed for ${affected.length} linked ${affected.length === 1 ? 'child' : 'children'}`,
      affected_child_ids: affected,
    },
  };
}
