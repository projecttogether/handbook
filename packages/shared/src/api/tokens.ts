import { z } from "zod";
import { idSchema } from "./common";

/** A personal access token: an AI agent or script acts as its owner (reads, and writes change sets). */
export const tokenSchema = z.object({
  id: idSchema,
  name: z.string(),
  /** The first characters, to recognize it. */
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type Token = z.infer<typeof tokenSchema>;
export const tokenListSchema = z.object({ items: z.array(tokenSchema) });

export const tokenCreateSchema = z.object({
  name: z.string().trim().min(1, "Add a name, e.g. the agent that uses it").max(80),
  /** Days until it stops working; null: never. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
});
export type TokenCreate = z.infer<typeof tokenCreateSchema>;

/** The new token. `secret` is shown once and never stored. */
export const tokenCreatedSchema = tokenSchema.extend({ secret: z.string() });
export type TokenCreated = z.infer<typeof tokenCreatedSchema>;

/** A read-only service token for integrations such as a support bot (admins). */
export const serviceTokenSchema = tokenSchema.extend({
  createdBy: z.string().nullable(),
});
export type ServiceToken = z.infer<typeof serviceTokenSchema>;
export const serviceTokenListSchema = z.object({ items: z.array(serviceTokenSchema) });
export const serviceTokenCreatedSchema = serviceTokenSchema.extend({ secret: z.string() });

/** An app connected through OAuth (Claude, ChatGPT, Langdock, …). */
export const connectedAppSchema = z.object({
  id: idSchema,
  clientName: z.string(),
  /** Where the app sends people back after sign-in, as a host name. */
  redirectHost: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ConnectedApp = z.infer<typeof connectedAppSchema>;
export const connectedAppListSchema = z.object({ items: z.array(connectedAppSchema) });

/** The consent screen of an OAuth sign-in. */
export const oauthRequestSchema = z.object({
  id: idSchema,
  /** The name the app gave itself; nobody checked it. */
  clientName: z.string(),
  /** The host that publishes the app's metadata document (its client_id); null for apps that registered themselves. */
  clientHost: z.string().nullable(),
  /** Where the browser goes after the decision: the host, with the scheme when it is not https. */
  redirectHost: z.string(),
  /** How the app registered: dynamic registration or a client metadata document. */
  registration: z.enum(["dynamic", "metadata_document"]),
  expiresAt: z.string(),
});
export type OauthRequest = z.infer<typeof oauthRequestSchema>;

export const oauthDecisionSchema = z.object({ redirectUrl: z.string() });

/** How to connect agents; shown on the settings page. */
export const connectInfoSchema = z.object({
  appUrl: z.string(),
  mcpUrl: z.string(),
});
export type ConnectInfo = z.infer<typeof connectInfoSchema>;
