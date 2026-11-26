import { z } from "zod";
import { idSchema } from "./common";
import { pageTypeDefinitionSchema, propertyDefinitionSchema } from "../page";
import { MAX_SPACE_SLUG_LENGTH, SPACE_SLUG_PATTERN } from "../paths";
import { spaceRoleSchema } from "../roles";
import { spaceTemplateKeySchema } from "../space-templates";

export const spaceSlugSchema = z
  .string()
  .trim()
  .min(1, "Add a short name for the URL")
  .max(MAX_SPACE_SLUG_LENGTH)
  .regex(SPACE_SLUG_PATTERN, "Use lowercase letters, digits and dashes, e.g. people-and-culture");

/** What the signed-in person may do in a space (`spaceAbilities`). */
export const abilitiesSchema = z.object({
  editLive: z.boolean(),
  review: z.boolean(),
  manage: z.boolean(),
  manageOwners: z.boolean(),
  propose: z.boolean(),
  seeDrafts: z.boolean(),
});

export const spaceSummarySchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  archived: z.boolean(),
  /** The live pages the viewer may see. */
  pageCount: z.number().int(),
  /** The signed-in person's role here; null for readers. */
  myRole: spaceRoleSchema.nullable(),
  /** The latest change of the space or of a page the viewer may see (live, or in the trash for editors). */
  updatedAt: z.string(),
});
export type SpaceSummary = z.infer<typeof spaceSummarySchema>;
export const spaceListSchema = z.object({ items: z.array(spaceSummarySchema) });
export const spaceListQuerySchema = z.object({
  /** Admins: include archived spaces. */
  archived: z.enum(["include", "only", "exclude"]).default("exclude"),
});

export const spaceSchema = spaceSummarySchema.extend({
  properties: z.array(propertyDefinitionSchema),
  pageTypes: z.array(pageTypeDefinitionSchema),
  abilities: abilitiesSchema,
  /** Open change sets of this space (open or in review) the viewer may see. */
  openChangeSets: z.number().int(),
  createdAt: z.string(),
});
export type Space = z.infer<typeof spaceSchema>;

export const spaceCreateSchema = z.object({
  slug: spaceSlugSchema,
  name: z.string().trim().min(1, "Add a name").max(80),
  description: z.string().trim().max(500).default(""),
  /** What the space starts with: page types, properties and starter pages (`space-templates.ts`). */
  template: spaceTemplateKeySchema.default("blank"),
});
export type SpaceCreate = z.infer<typeof spaceCreateSchema>;

export const spaceUpdateSchema = z.object({
  name: z.string().trim().min(1, "Add a name").max(80).optional(),
  description: z.string().trim().max(500).optional(),
  properties: z.array(propertyDefinitionSchema).max(100).optional(),
  pageTypes: z.array(pageTypeDefinitionSchema).max(50).optional(),
});
export type SpaceUpdate = z.infer<typeof spaceUpdateSchema>;

export const spaceMemberSchema = z.object({
  userId: idSchema,
  email: z.string(),
  name: z.string(),
  role: spaceRoleSchema,
  /** False until the person signs in for the first time. */
  signedIn: z.boolean(),
});
export type SpaceMember = z.infer<typeof spaceMemberSchema>;
export const spaceMemberListSchema = z.object({ items: z.array(spaceMemberSchema) });

/** Adds a person by email (also before their first sign-in) or changes their role. */
export const spaceMemberPutSchema = z.object({
  email: z.email("Use an email address").trim().toLowerCase(),
  role: spaceRoleSchema,
});
export type SpaceMemberPut = z.infer<typeof spaceMemberPutSchema>;

/** An uploaded file. `markdown` is ready to paste into a page. */
export const fileInfoSchema = z.object({
  id: idSchema,
  name: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  url: z.string(),
  markdown: z.string(),
});
export type FileInfo = z.infer<typeof fileInfoSchema>;
