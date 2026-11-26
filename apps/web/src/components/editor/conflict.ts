import { hasConflictMarkers } from "@handbook/shared/merge";

/** The body of a 409 `page_changed` answer (contract: pageConflictSchema). */
export type PageConflict = {
  currentRevision: number;
  merged: string;
  conflicts: number;
  updatedBy: string | null;
};

/** Reads a 409 `page_changed` body; null when it is something else. */
export function readPageConflict(body: unknown): PageConflict | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as {
    error?: { code?: unknown };
    current?: { revision?: unknown; updatedBy?: { name?: unknown } | null };
    merged?: unknown;
    conflicts?: unknown;
  };
  if (value.error?.code !== "page_changed") return null;
  if (typeof value.current?.revision !== "number" || typeof value.merged !== "string") return null;
  return {
    currentRevision: value.current.revision,
    merged: value.merged,
    conflicts: typeof value.conflicts === "number" ? value.conflicts : 0,
    updatedBy: typeof value.current.updatedBy?.name === "string" ? value.current.updatedBy.name : null,
  };
}

export type SaveBase = { file: string; baseRevision: number; conflict: PageConflict | null };

/**
 * After a conflict, the editor holds the merged text with conflict blocks,
 * and the next save starts from the current revision.
 */
export function applyConflict(state: SaveBase, conflict: PageConflict): SaveBase {
  return { file: conflict.merged, baseRevision: conflict.currentRevision, conflict };
}

/** Why the editor may not save now, or null. */
export function saveBlocker(file: string): "conflict_markers" | null {
  return hasConflictMarkers(file) ? "conflict_markers" : null;
}
