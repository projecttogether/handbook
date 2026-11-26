import { z } from "zod";
import { actorSchema, idSchema, pageQuerySchema } from "./common";
import { abilitiesSchema } from "./spaces";
import { pageStatusSchema } from "../page";
import { MAX_PATH_LENGTH } from "../paths";
import { viaSchema } from "../roles";

const pathSchema = z.string().trim().min(1).max(MAX_PATH_LENGTH);

/** A page in lists and trees. */
export const pageSummarySchema = z.object({
  id: idSchema,
  space: z.string(),
  path: z.string(),
  parentId: idSchema.nullable(),
  position: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  status: pageStatusSchema,
  type: z.string().nullable(),
  tags: z.array(z.string()),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export type PageSummary = z.infer<typeof pageSummarySchema>;
export const pageTreeSchema = z.object({ items: z.array(pageSummarySchema) });

export const lockHolderSchema = z.object({
  user: actorSchema,
  since: z.string(),
  /** True when the signed-in person holds it (e.g. in another tab). */
  mine: z.boolean(),
});
export type LockHolder = z.infer<typeof lockHolderSchema>;

export const pageRefSchema = z.object({
  id: idSchema,
  space: z.string(),
  path: z.string(),
  title: z.string(),
});
export type PageRef = z.infer<typeof pageRefSchema>;

/** A page with its file and context. */
export const pageSchema = pageSummarySchema.extend({
  spaceName: z.string(),
  /** The whole file: frontmatter and body. */
  markdown: z.string(),
  /** The body without frontmatter. */
  body: z.string(),
  /** Every frontmatter value, built-in and custom, as stored. */
  properties: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedBy: actorSchema.nullable(),
  breadcrumbs: z.array(pageRefSchema),
  children: z.array(pageSummarySchema),
  backlinks: z.array(pageRefSchema),
  lock: lockHolderSchema.nullable(),
  /** The signed-in person's unsaved draft of this page, if any. */
  draft: z.object({ baseRevision: z.number().int(), updatedAt: z.string() }).nullable(),
  /** Open change sets that change this page. */
  changeSets: z.array(z.object({ number: z.number().int(), title: z.string(), status: z.string() })),
  abilities: abilitiesSchema,
});
export type Page = z.infer<typeof pageSchema>;

export const pageByPathQuerySchema = z.object({ path: pathSchema });

/** Creates a page live (editors). Without `slug`, the slug comes from the title. */
export const pageCreateSchema = z.object({
  parentPath: pathSchema.nullable().default(null),
  slug: z.string().trim().max(80).optional(),
  markdown: z.string().min(1),
});
export type PageCreate = z.infer<typeof pageCreateSchema>;

/** Saves a new version of a page live (editors). */
export const pageSaveSchema = z.object({
  markdown: z.string().min(1),
  /** The revision the editor started from. */
  baseRevision: z.number().int().min(1),
  /** The edit lock this editor holds; released after the save. */
  lockToken: z.uuid().optional(),
  message: z.string().trim().max(300).optional(),
});
export type PageSave = z.infer<typeof pageSaveSchema>;

/**
 * 409 `page_changed`: the page changed since `baseRevision` and the changes
 * overlap. `merged` holds both versions with conflict blocks to resolve.
 */
export const pageConflictSchema = z.object({
  error: z.object({ code: z.literal("page_changed"), message: z.string() }),
  current: z.object({ revision: z.number().int(), markdown: z.string(), updatedBy: actorSchema.nullable() }),
  merged: z.string(),
  conflicts: z.number().int(),
});
export type PageConflict = z.infer<typeof pageConflictSchema>;

export const pageMoveSchema = z.object({
  /** New parent, or null for the top level. */
  parentPath: pathSchema.nullable(),
  slug: z.string().trim().min(1).max(80),
  /** Place among the new siblings (0 = first); default: last. */
  position: z.number().int().min(0).optional(),
});
export type PageMove = z.infer<typeof pageMoveSchema>;

export const revisionKindSchema = z.enum(["save", "move", "delete", "restore"]);

export const revisionSummarySchema = z.object({
  number: z.number().int(),
  kind: revisionKindSchema,
  path: z.string(),
  title: z.string(),
  author: actorSchema.nullable(),
  via: viaSchema,
  /** The agent or app that made the change, e.g. "Claude". */
  clientName: z.string().nullable(),
  changeSet: z.object({ number: z.number().int(), title: z.string() }).nullable(),
  message: z.string().nullable(),
  added: z.number().int(),
  removed: z.number().int(),
  createdAt: z.string(),
});
export type RevisionSummary = z.infer<typeof revisionSummarySchema>;
/** Newest first; `offset` skips the newest. */
export const revisionListQuerySchema = pageQuerySchema;
export const revisionListSchema = z.object({
  items: z.array(revisionSummarySchema),
  total: z.number().int(),
});
export type RevisionList = z.infer<typeof revisionListSchema>;

export const revisionSchema = revisionSummarySchema.extend({
  markdown: z.string(),
  /** The previous revision's file, for a diff; null for the first. */
  previousMarkdown: z.string().nullable(),
});
export type Revision = z.infer<typeof revisionSchema>;

export const revisionRestoreSchema = z.object({ baseRevision: z.number().int().min(1) });

export const lockResponseSchema = z.object({
  token: z.uuid(),
  renewSeconds: z.number().int(),
  expireSeconds: z.number().int(),
  idleSeconds: z.number().int(),
});
export type LockResponse = z.infer<typeof lockResponseSchema>;

export const lockRenewSchema = z.object({
  token: z.uuid(),
  /** True when the person typed since the last renewal. */
  active: z.boolean(),
});

/** 423 `page_locked`: someone else edits the page. */
export const pageLockedSchema = z.object({
  error: z.object({ code: z.literal("page_locked"), message: z.string() }),
  lock: lockHolderSchema,
});

export const draftSchema = z.object({
  markdown: z.string(),
  baseRevision: z.number().int(),
  updatedAt: z.string(),
});
export type Draft = z.infer<typeof draftSchema>;
export const draftPutSchema = z.object({
  markdown: z.string().min(1).max(600_000),
  baseRevision: z.number().int().min(1),
});

export const trashItemSchema = pageSummarySchema.extend({
  deletedAt: z.string(),
  deletedBy: actorSchema.nullable(),
});
export const trashListSchema = z.object({ items: z.array(trashItemSchema) });

export const recentChangeSchema = z.object({
  page: pageRefSchema,
  revision: revisionSummarySchema,
});
export const recentListSchema = z.object({ items: z.array(recentChangeSchema) });
export const recentQuerySchema = z.object({
  space: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const tagListSchema = z.object({
  items: z.array(z.object({ tag: z.string(), count: z.number().int() })),
});
export const tagRenameSchema = z.object({
  from: z.string().trim().min(1).max(50),
  /** An existing tag merges the two. */
  to: z.string().trim().min(1).max(50),
});

/** Answer of a successful lock renewal. */
export const lockRenewResultSchema = z.object({ ok: z.literal(true), expiresAt: z.string() });

/** 409 `lock_lost`: the lock ended or someone took it over (`takenOverBy`, null when it just ended). */
export const lockLostSchema = z.object({
  error: z.object({ code: z.literal("lock_lost"), message: z.string() }),
  takenOverBy: actorSchema.nullable(),
});

export const tagRenameResultSchema = z.object({
  /** Pages whose tags changed. */
  changed: z.number().int(),
  /** Pages left as they were because they no longer fit their space's properties. */
  skipped: z.number().int(),
});
