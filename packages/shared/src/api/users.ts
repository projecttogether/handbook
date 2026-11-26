import { z } from "zod";
import { idSchema, pageQuerySchema } from "./common";
import { spaceRoleSchema } from "../roles";

/** The signed-in person. */
export const meSchema = z.object({
  id: idSchema,
  email: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  isAdmin: z.boolean(),
  /** Spaces where this person is owner or editor. */
  spaces: z.array(z.object({ slug: z.string(), role: spaceRoleSchema })),
});
export type Me = z.infer<typeof meSchema>;

/** What runs (admins): the version is the commit the image was built from; null for a build from source. */
export const aboutSchema = z.object({ version: z.string().nullable() });
export type About = z.infer<typeof aboutSchema>;

/** Public: what the sign-in page shows. */
export const authConfigSchema = z.object({
  appName: z.string(),
  providerName: z.string(),
});
export type AuthConfig = z.infer<typeof authConfigSchema>;

/** A person as admins see them. */
export const personSchema = z.object({
  id: idSchema,
  email: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  /** environment: listed in ADMIN_EMAILS (always admin); app: made admin in the app. */
  adminSource: z.enum(["environment", "app"]).nullable(),
  blocked: z.boolean(),
  /** Spaces where this person is owner or editor. */
  spaces: z.array(z.object({ slug: z.string(), name: z.string(), role: spaceRoleSchema })),
  lastSignInAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Person = z.infer<typeof personSchema>;
export const peopleQuerySchema = z.object({ q: z.string().trim().max(100).optional() });
export const peopleListSchema = z.object({ items: z.array(personSchema) });

export const personUpdateSchema = z.object({
  isAdmin: z.boolean().optional(),
  /** Blocked people cannot sign in; their sessions and tokens stop working. */
  blocked: z.boolean().optional(),
});
export type PersonUpdate = z.infer<typeof personUpdateSchema>;

/**
 * `DELETE /admin/people/:id` removes a person (204): their name and email
 * are replaced, their sign-ins, tokens, connected apps, drafts and roles
 * deleted. Their revisions, change sets and comments stay, shown under this
 * name. Signing in again makes a new, empty person.
 */
export const REMOVED_PERSON_NAME = "Removed person";

export const auditEntrySchema = z.object({
  id: idSchema,
  createdAt: z.string(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  /** Short description, e.g. 'Created the space IT'. Never contains secrets. */
  summary: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditListQuerySchema = pageQuerySchema;
export const auditListSchema = z.object({ items: z.array(auditEntrySchema), total: z.number().int() });
