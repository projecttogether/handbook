import { z } from "zod";
import { actorSchema, idSchema } from "./common";
import { MAX_PATH_LENGTH } from "../paths";

/**
 * Change sets: the app's branch and pull request. Changes to one or more
 * pages of one space that stay invisible until an editor merges them.
 *
 *   open → in_review → merged
 *     ↘ closed (and back to open)
 */
export const CHANGE_SET_STATUSES = ["open", "in_review", "merged", "closed"] as const;
export const changeSetStatusSchema = z.enum(CHANGE_SET_STATUSES);
export type ChangeSetStatus = z.infer<typeof changeSetStatusSchema>;

export const ITEM_ACTIONS = ["create", "update", "delete"] as const;
export const itemActionSchema = z.enum(ITEM_ACTIONS);
export type ItemAction = z.infer<typeof itemActionSchema>;

export const changeSetSummarySchema = z.object({
  id: idSchema,
  number: z.number().int(),
  space: z.object({ slug: z.string(), name: z.string() }),
  title: z.string(),
  status: changeSetStatusSchema,
  author: actorSchema.nullable(),
  /** The agent or app that made it, e.g. "Claude"; null when made in the web app. */
  clientName: z.string().nullable(),
  pages: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
});
export type ChangeSetSummary = z.infer<typeof changeSetSummarySchema>;
export const changeSetListSchema = z.object({ items: z.array(changeSetSummarySchema) });
export const changeSetListQuerySchema = z.object({
  space: z.string().optional(),
  status: z.enum(["active", "open", "in_review", "merged", "closed", "all"]).default("active"),
  mine: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const changeSetItemSchema = z.object({
  pageId: idSchema,
  action: itemActionSchema,
  /** The page's path after the change (create, update) or its live path (delete). */
  path: z.string(),
  /** The live path when the change moves the page; else null. */
  fromPath: z.string().nullable(),
  title: z.string(),
  /** The live revision the change started from; null for new pages. */
  baseRevision: z.number().int().nullable(),
  /** The page's live revision now; differs from baseRevision when it changed meanwhile. */
  liveRevision: z.number().int().nullable(),
  added: z.number().int(),
  removed: z.number().int(),
  /** The live page changed since baseRevision in a way that overlaps this change. */
  conflict: z.boolean(),
  updatedAt: z.string(),
  updatedBy: actorSchema.nullable(),
});
export type ChangeSetItem = z.infer<typeof changeSetItemSchema>;

export const checkSchema = z.object({
  level: z.enum(["error", "warning"]),
  pageId: idSchema.nullable(),
  path: z.string().nullable(),
  message: z.string(),
});
export type Check = z.infer<typeof checkSchema>;

export const CHANGE_SET_EVENT_KINDS = [
  "created",
  "edited",
  "comment",
  "submitted",
  "changes_requested",
  "merged",
  "closed",
  "reopened",
  "reverted",
] as const;
export type ChangeSetEventKind = (typeof CHANGE_SET_EVENT_KINDS)[number];

export const changeSetEventSchema = z.object({
  id: idSchema,
  kind: z.enum(CHANGE_SET_EVENT_KINDS),
  actor: actorSchema.nullable(),
  clientName: z.string().nullable(),
  /** The comment, or a short description of an edit. */
  body: z.string().nullable(),
  page: z.object({ id: idSchema, path: z.string(), title: z.string() }).nullable(),
  createdAt: z.string(),
});
export type ChangeSetEvent = z.infer<typeof changeSetEventSchema>;

export const changeSetPermissionsSchema = z.object({
  /** Change pages in it, title and description. */
  edit: z.boolean(),
  submit: z.boolean(),
  review: z.boolean(),
  merge: z.boolean(),
  close: z.boolean(),
  reopen: z.boolean(),
  revert: z.boolean(),
  comment: z.boolean(),
});

export const changeSetSchema = changeSetSummarySchema.extend({
  description: z.string(),
  items: z.array(changeSetItemSchema),
  checks: z.array(checkSchema),
  events: z.array(changeSetEventSchema),
  mergedBy: actorSchema.nullable(),
  revertOf: z.number().int().nullable(),
  revertedBy: z.number().int().nullable(),
  permissions: changeSetPermissionsSchema,
});
export type ChangeSet = z.infer<typeof changeSetSchema>;

export const changeSetCreateSchema = z.object({
  space: z.string().trim().min(1),
  title: z.string().trim().min(1, "Add a title").max(200),
  description: z.string().trim().max(10_000).default(""),
});
export type ChangeSetCreate = z.infer<typeof changeSetCreateSchema>;

export const changeSetUpdateSchema = z.object({
  title: z.string().trim().min(1, "Add a title").max(200).optional(),
  description: z.string().trim().max(10_000).optional(),
});

/** One page as a change set sees it: the live version and the proposed one. */
export const changeSetPageSchema = z.object({
  item: changeSetItemSchema,
  /** The file the change started from (base revision); null for new pages. */
  base: z.string().nullable(),
  /** The live file now; null for new pages. */
  live: z.string().nullable(),
  /** The proposed file; null when the change deletes the page. */
  proposed: z.string().nullable(),
});
export type ChangeSetPage = z.infer<typeof changeSetPageSchema>;

const pathSchema = z.string().trim().min(1).max(MAX_PATH_LENGTH);

/**
 * Puts a whole page file into a change set. Without `pageId`, `path` names
 * the page: an existing live page is updated, a new path creates a page.
 */
export const changeSetPutPageSchema = z
  .object({
    pageId: idSchema.optional(),
    path: pathSchema.optional(),
    markdown: z.string().min(1),
    /**
     * The live revision the file was written from, when the change set does
     * not change the page yet. Changes saved live after it are then merged,
     * not undone. Default: the live revision now.
     */
    baseRevision: z.number().int().min(1).optional(),
  })
  .refine((value) => value.pageId || value.path, { message: "Give pageId or path", path: ["path"] });

export const changeSetEditPageSchema = z.object({
  edits: z
    .array(
      z.object({
        oldText: z.string().min(1),
        newText: z.string(),
        replaceAll: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const changeSetMovePageSchema = z.object({ path: pathSchema });

export const commentSchema = z.object({ body: z.string().trim().min(1, "Write a comment").max(10_000) });
export const submitSchema = z.object({ note: z.string().trim().max(10_000).optional() });

/** 409 `merge_conflicts`: pages whose live version changed in overlapping ways. */
export const mergeConflictsSchema = z.object({
  error: z.object({ code: z.literal("merge_conflicts"), message: z.string() }),
  conflicts: z.array(z.object({ pageId: idSchema, path: z.string(), reason: z.string() })),
});

export const revertResultSchema = z.object({
  number: z.number().int(),
  /** False when the revert needs a person to resolve conflicts first. */
  merged: z.boolean(),
});
