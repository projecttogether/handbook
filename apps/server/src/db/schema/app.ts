import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PageTypeDefinition, Properties, PropertyDefinition } from "@handbook/shared/page";
import { users } from "./auth";

/** PostgreSQL full-text search vector; written with SQL (`to_tsvector`), never read by the app. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** App state by key (e.g. the search languages the index was built with). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Changes by admins and owners (spaces, members, people, tokens). Never stores secrets. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_audit_log_created").on(table.createdAt)],
);

/** A knowledge base: pages, the people who edit them, and what their frontmatter may hold. */
export const spaces = pgTable("spaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** In URLs: /s/<slug>. */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  properties: jsonb("properties").$type<PropertyDefinition[]>().notNull().default([]),
  pageTypes: jsonb("page_types").$type<PageTypeDefinition[]>().notNull().default([]),
  /** Archived spaces are read-only and hidden from lists. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...timestamps,
});

/** Owners and editors of a space. Everyone else reads. */
export const spaceMembers = pgTable(
  "space_members",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** owner or editor (`@handbook/shared/roles`). */
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.userId] }),
    index("idx_space_members_user").on(table.userId),
  ],
);

/**
 * The live version of each page. The file itself lives in `page_revisions`
 * (`current_revision`); the columns here are derived from it on every save.
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    /** Full path within the space, e.g. onboarding/laptop. */
    path: text("path").notNull(),
    position: integer("position").notNull().default(0),
    /** Number of the current revision. */
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    type: text("type"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    searchTerms: text("search_terms")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Every frontmatter value as stored (built-in and custom). */
    properties: jsonb("properties").$type<Properties>().notNull().default({}),
    /** The whole file of the current revision. */
    markdown: text("markdown").notNull(),
    /** Title, search terms, tags and description for search. */
    searchVector: tsvector("search_vector"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    updatedById: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    /** In the trash since. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_pages_space_path_live")
      .on(table.spaceId, table.path)
      .where(sql`${table.deletedAt} is null`),
    index("idx_pages_parent").on(table.parentId),
    index("idx_pages_space").on(table.spaceId),
    // Live drafts, which hide the pages below them (spaces/visibility.ts).
    index("idx_pages_live_drafts")
      .on(table.spaceId, table.path)
      .where(sql`${table.status} = 'draft' and ${table.deletedAt} is null`),
    index("idx_pages_tags").using("gin", table.tags),
    index("idx_pages_search").using("gin", table.searchVector),
    index("idx_pages_title_trgm").using("gin", sql`${table.title} gin_trgm_ops`),
    index("idx_pages_updated").on(table.updatedAt),
  ],
);

/** Every version of every page: full file, who, how, and through which change set. */
export const pageRevisions = pgTable(
  "page_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    /** save, move, delete or restore. */
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    markdown: text("markdown").notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** web, api, mcp, import, merge, revert or restore (`@handbook/shared/roles`). */
    via: text("via").notNull(),
    /** The agent or app, e.g. "Claude". */
    clientName: text("client_name"),
    changeSetId: uuid("change_set_id"),
    message: text("message"),
    added: integer("added").notNull().default(0),
    removed: integer("removed").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_page_revisions_number").on(table.pageId, table.number),
    index("idx_page_revisions_change_set").on(table.changeSetId),
    index("idx_page_revisions_created").on(table.createdAt),
  ],
);

/** Sections of live pages (split at headings) for search. */
export const pageSections = pgTable(
  "page_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** Heading anchor (as the web app renders it); null for the text before the first heading. */
    anchor: text("anchor"),
    headingPath: text("heading_path")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    content: text("content").notNull(),
    searchVector: tsvector("search_vector"),
  },
  (table) => [
    index("idx_page_sections_page").on(table.pageId),
    index("idx_page_sections_search").using("gin", table.searchVector),
  ],
);

/** Links from live pages to pages (backlinks, broken links). */
export const pageLinks = pgTable(
  "page_links",
  {
    fromPageId: uuid("from_page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    toSpaceSlug: text("to_space_slug").notNull(),
    toPath: text("to_path").notNull(),
    /** The page the link reaches now (also through a redirect); null: broken. */
    toPageId: uuid("to_page_id").references(() => pages.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.fromPageId, table.toSpaceSlug, table.toPath] }),
    index("idx_page_links_to_page").on(table.toPageId),
    index("idx_page_links_to_path").on(table.toSpaceSlug, table.toPath),
  ],
);

/** Old paths of moved pages, so links and bookmarks keep working. */
export const redirects = pgTable(
  "redirects",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.path] })],
);

/** Uploaded files (images, attachments), stored under FILES_DIR. */
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    /** File name under FILES_DIR. */
    storageKey: text("storage_key").notNull().unique(),
    uploadedById: uuid("uploaded_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * When saved content (a page, change set, draft, comment or space
     * setting) first mentioned `/files/<id>`; unused uploads are removed.
     */
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_files_space").on(table.spaceId),
    index("idx_files_unused")
      .on(table.createdAt)
      .where(sql`${table.usedAt} is null`),
  ],
);

/** Who edits a page in the web editor right now (docs/architecture.md, "Edit locks"). */
export const editLocks = pgTable("edit_locks", {
  pageId: uuid("page_id")
    .primaryKey()
    .references(() => pages.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Identifies one open editor; a takeover or another tab replaces it. */
  token: uuid("token").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
  /** Last typing in the editor. */
  activityAt: timestamp("activity_at", { withTimezone: true }).notNull().defaultNow(),
  /** Who took the previous lock over, so its editor can say so. */
  takenOverFromUserId: uuid("taken_over_from_user_id").references(() => users.id, { onDelete: "set null" }),
  takenOverToken: uuid("taken_over_token"),
});

/** Unsaved text of the web editor, per person and page. */
export const drafts = pgTable(
  "drafts",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    markdown: text("markdown").notNull(),
    baseRevision: integer("base_revision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.pageId, table.userId] })],
);

/** Proposed changes to pages of one space: the app's branch and pull request. */
export const changeSets = pgTable(
  "change_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").generatedAlwaysAsIdentity().notNull().unique(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** open, in_review, merged or closed. */
    status: text("status").notNull().default("open"),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** web, token or oauth: how the author worked. */
    channel: text("channel").notNull(),
    clientName: text("client_name"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergedById: uuid("merged_by_id").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** The change set this one reverts. */
    revertOfId: uuid("revert_of_id"),
    /** The change set that reverted this one. */
    revertedById: uuid("reverted_by_id"),
    ...timestamps,
  },
  (table) => [index("idx_change_sets_space_status").on(table.spaceId, table.status)],
);

/** One page's change in a change set. */
export const changeSetItems = pgTable(
  "change_set_items",
  {
    changeSetId: uuid("change_set_id")
      .notNull()
      .references(() => changeSets.id, { onDelete: "cascade" }),
    /** The live page, or the id the new page gets at merge. */
    pageId: uuid("page_id").notNull(),
    /** create, update or delete. */
    action: text("action").notNull(),
    /** The live revision the change started from; null for new pages. */
    baseRevision: integer("base_revision"),
    /** The path after the change; for deletes the live path. */
    path: text("path").notNull(),
    /** The proposed file; null for deletes. */
    markdown: text("markdown"),
    updatedById: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.changeSetId, table.pageId] }),
    // The page view lists the open change sets of a page.
    index("idx_change_set_items_page").on(table.pageId),
  ],
);

/** The timeline of a change set: edits, comments and status changes. */
export const changeSetEvents = pgTable(
  "change_set_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    changeSetId: uuid("change_set_id")
      .notNull()
      .references(() => changeSets.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    clientName: text("client_name"),
    body: text("body"),
    pageId: uuid("page_id"),
    pagePath: text("page_path"),
    pageTitle: text("page_title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_change_set_events_change_set").on(table.changeSetId, table.createdAt)],
);

/**
 * Credentials of agents and integrations, stored as SHA-256 hashes:
 * personal access tokens, read-only service tokens, and the access and
 * refresh tokens of connected apps (OAuth).
 */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** personal, service, oauth_access or oauth_refresh. */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    /** The person a personal or OAuth token acts as; null for service tokens. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Created with the operator command, so by no user. */
    createdByOperator: boolean("created_by_operator").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_credentials_user").on(table.userId),
    index("idx_credentials_grant").on(table.grantId),
  ],
);

/** Apps that may ask people to connect them (OAuth clients): registered or by metadata document. */
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Generated for dynamic registration; the document URL for metadata documents. */
  clientId: text("client_id").notNull().unique(),
  /** dynamic or metadata_document. */
  registration: text("registration").notNull(),
  secretHash: text("secret_hash"),
  name: text("name").notNull(),
  clientUri: text("client_uri"),
  redirectUris: text("redirect_uris").array().notNull(),
  /** none, client_secret_post or client_secret_basic. */
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  /** When the metadata document was last read. */
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  ...timestamps,
});

/** A person's consent for a connected app; revoking it ends all its tokens. */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_oauth_grants_user").on(table.userId)],
);

/** A pending sign-in of a connected app, from /oauth/authorize to the consent and code. */
export const oauthRequests = pgTable("oauth_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope"),
  resource: text("resource"),
  /** The person who opened the consent screen first; only they may decide. */
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 of the authorization code, once approved. */
  codeHash: text("code_hash").unique(),
  grantId: uuid("grant_id"),
  codeUsedAt: timestamp("code_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
