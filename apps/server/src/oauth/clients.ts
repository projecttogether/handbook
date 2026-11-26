import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { oauthClients, oauthGrants, oauthRequests } from "../db/schema";
import { hashToken, sameHash } from "../auth/credentials";
import { logger } from "../logger";

/**
 * Apps that connect through OAuth (MCP clients). They register in one of
 * two ways:
 * - dynamic client registration (RFC 7591): `POST /oauth/register`;
 * - a client metadata document: the `client_id` is an https URL whose JSON
 *   names the app and its redirect URIs. It is fetched with SSRF protection
 *   and cached for an hour.
 * Clients that never got a grant are removed after a few days.
 */

export type ClientRow = typeof oauthClients.$inferSelect;

/** An OAuth error response: `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

const DOCUMENT_CACHE_MS = 60 * 60 * 1000;
const DOCUMENT_MAX_BYTES = 64 * 1024;
const DOCUMENT_TIMEOUT_MS = 5_000;
/** Metadata documents read at the same time, per process. */
export const DOCUMENT_MAX_CONCURRENT = 8;
const UNUSED_CLIENT_DAYS = 3;
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why a redirect URI is not allowed; null when fine. https, http on
 * loopback, or a native app's own scheme (RFC 8252 7.1, e.g. Cursor's
 * `cursor://anysphere.cursor-mcp/oauth/callback`); never schemes that run
 * or show content in the browser (javascript:, data:, …).
 */
export function redirectUriProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Not a URL";
  }
  if (url.hash) return "Redirect URIs cannot have a fragment";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:")
    return LOOPBACK_HOSTS.has(url.hostname) ? null : "Use https (http only on localhost)";
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return "This scheme is not allowed";
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? null : "Not a valid scheme";
}

/**
 * Where a redirect URI leads, for people to check: the host for https,
 * with the scheme for anything else (`http://127.0.0.1:8787`,
 * `cursor://anysphere.cursor-mcp`), so another scheme cannot pass for a website.
 */
export function redirectTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol === "https:" && url.host) return url.host;
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

/**
 * True when `given` matches a registered redirect URI: exactly, or for
 * http on loopback with any port (RFC 8252: native apps pick a free port).
 */
export function matchesRedirectUri(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return false;
  return registered.some((candidate) => {
    try {
      const other = new URL(candidate);
      return (
        other.protocol === "http:" &&
        other.hostname === url.hostname &&
        other.pathname === url.pathname &&
        other.search === url.search
      );
    } catch {
      return false;
    }
  });
}

export const registrationSchema = z.looseObject({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
  client_uri: z.string().max(2000).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().max(1000).optional(),
});

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
const GRANT_TYPES = ["authorization_code", "refresh_token"];

function httpsUrlOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function checkGrantAndResponseTypes(input: { grant_types?: string[]; response_types?: string[] }) {
  if (input.grant_types && input.grant_types.some((type) => !GRANT_TYPES.includes(type))) {
    throw new OAuthError(
      400,
      "invalid_client_metadata",
      "Supported grant types: authorization_code, refresh_token",
    );
  }
  if (input.response_types && input.response_types.some((type) => type !== "code")) {
    throw new OAuthError(400, "invalid_client_metadata", "The only supported response type is code");
  }
}

/** Dynamic client registration. Returns the RFC 7591 response body. */
export async function registerClient(db: DbOrTx, body: unknown) {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    throw new OAuthError(400, "invalid_client_metadata", "Send redirect_uris (1 to 10) and valid metadata");
  }
  const input = parsed.data;
  for (const uri of input.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthError(400, "invalid_redirect_uri", `${uri}: ${problem}`);
  }
  checkGrantAndResponseTypes(input);
  const method = input.token_endpoint_auth_method ?? "client_secret_basic";
  if (!(AUTH_METHODS as readonly string[]).includes(method)) {
    throw new OAuthError(
      400,
      "invalid_client_metadata",
      `Supported token_endpoint_auth_method: ${AUTH_METHODS.join(", ")}`,
    );
  }
  const clientId = `kn_client_${randomBytes(16).toString("base64url")}`;
  const secret = method === "none" ? null : `kn_cs_${randomBytes(32).toString("base64url")}`;
  const name = input.client_name || "Connected app";
  const [row] = await db
    .insert(oauthClients)
    .values({
      clientId,
      registration: "dynamic",
      secretHash: secret ? hashToken(secret) : null,
      name,
      clientUri: httpsUrlOrNull(input.client_uri),
      redirectUris: input.redirect_uris,
      tokenEndpointAuthMethod: method,
    })
    .returning();
  logger.info({ clientId: row!.id }, "OAuth client registered");
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(row!.createdAt.getTime() / 1000),
    client_name: name,
    redirect_uris: input.redirect_uris,
    token_endpoint_auth_method: method,
    grant_types: GRANT_TYPES,
    response_types: ["code"],
    scope: "handbook",
  };
}

/** True for a client id that is a metadata document URL. */
export function isMetadataDocumentId(clientId: string): boolean {
  return /^https?:\/\//i.test(clientId);
}

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

/**
 * Fetches a client metadata document: https only, public addresses only
 * (the connection goes to the address that was checked), no redirects,
 * at most 64 KB within 5 seconds.
 */
export async function fetchMetadataDocument(clientId: string): Promise<unknown> {
  const allowPrivate = config().OAUTH_ALLOW_PRIVATE_CLIENT_URLS;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError(400, "invalid_client", "The client_id is not a valid URL");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new OAuthError(400, "invalid_client", "Client metadata documents must use https");
  }
  if (url.username || url.password || url.hash) {
    throw new OAuthError(
      400,
      "invalid_client",
      "The client_id URL may not contain credentials or a fragment",
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new OAuthError(400, "invalid_client", "The client's metadata document host cannot be resolved");
  }
  if (
    addresses.length === 0 ||
    (!allowPrivate && addresses.some((entry) => !isPublicAddress(entry.address)))
  ) {
    throw new OAuthError(
      400,
      "invalid_client",
      "The client's metadata document is on a private network address",
    );
  }
  const pinned = addresses[0]!;
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const fail = (description: string) => reject(new OAuthError(400, "invalid_client", description));
    const request = client.request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "Handbook" },
        lookup: (_hostname, options, callback) => {
          if ((options as { all?: boolean }).all) {
            (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, [
              pinned,
            ]);
          } else {
            (callback as (error: null, address: string, family: number) => void)(
              null,
              pinned.address,
              pinned.family,
            );
          }
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          fail(`The client's metadata document answered HTTP ${response.statusCode ?? "?"}`);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > DOCUMENT_MAX_BYTES) {
            request.destroy();
            fail("The client's metadata document is too large");
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            fail("The client's metadata document is not JSON");
          }
        });
        response.on("error", () => fail("Reading the client's metadata document failed"));
      },
    );
    const timer = setTimeout(() => request.destroy(new Error("timeout")), DOCUMENT_TIMEOUT_MS);
    request.on("error", () => fail("The client's metadata document could not be read"));
    request.on("close", () => clearTimeout(timer));
    request.end();
  });
}

const documentFetches = new Map<string, Promise<unknown>>();

/**
 * Reads a metadata document once at a time per client, and at most
 * DOCUMENT_MAX_CONCURRENT documents at once, so that sign-in requests
 * cannot make the server fetch many URLs.
 */
function fetchDocumentOnce(clientId: string): Promise<unknown> {
  const running = documentFetches.get(clientId);
  if (running) return running;
  if (documentFetches.size >= DOCUMENT_MAX_CONCURRENT) {
    throw new OAuthError(
      503,
      "temporarily_unavailable",
      "Too many apps are connecting right now. Try again in a minute.",
    );
  }
  const fetching = fetchMetadataDocument(clientId).finally(() => documentFetches.delete(clientId));
  documentFetches.set(clientId, fetching);
  return fetching;
}

const documentSchema = z.looseObject({
  client_id: z.string(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
  client_uri: z.string().max(2000).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

/** Reads (or re-reads after an hour) a client metadata document and stores the client. */
async function clientFromDocument(
  db: DbOrTx,
  clientId: string,
  cached: ClientRow | null,
): Promise<ClientRow> {
  if (cached?.fetchedAt && Date.now() - cached.fetchedAt.getTime() < DOCUMENT_CACHE_MS) return cached;
  const parsed = documentSchema.safeParse(await fetchDocumentOnce(clientId));
  if (!parsed.success)
    throw new OAuthError(400, "invalid_client", "The client's metadata document is not valid");
  const document = parsed.data;
  if (document.client_id !== clientId) {
    throw new OAuthError(400, "invalid_client", "The client's metadata document names another client_id");
  }
  for (const uri of document.redirect_uris) {
    if (redirectUriProblem(uri))
      throw new OAuthError(400, "invalid_client", `Invalid redirect URI in the document: ${uri}`);
  }
  checkGrantAndResponseTypes(document);
  if (document.token_endpoint_auth_method && document.token_endpoint_auth_method !== "none") {
    throw new OAuthError(
      400,
      "invalid_client",
      "Clients with metadata documents must use token_endpoint_auth_method none",
    );
  }
  const values = {
    registration: "metadata_document",
    name: document.client_name || new URL(clientId).hostname,
    clientUri: httpsUrlOrNull(document.client_uri),
    redirectUris: document.redirect_uris,
    tokenEndpointAuthMethod: "none",
    secretHash: null,
    fetchedAt: new Date(),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(oauthClients)
    .values({ clientId, ...values })
    .onConflictDoUpdate({ target: oauthClients.clientId, set: values })
    .returning();
  return row!;
}

/**
 * The client of an authorization request. Metadata documents are fetched
 * when not cached (or older than an hour); null when the client is unknown.
 */
export async function clientForAuthorization(db: DbOrTx, clientId: string): Promise<ClientRow | null> {
  const [cached] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  if (isMetadataDocumentId(clientId)) return clientFromDocument(db, clientId, cached ?? null);
  return cached && cached.registration === "dynamic" ? cached : null;
}

/** The stored client (no fetching), for the token and revocation endpoints. */
export async function storedClient(db: DbOrTx, clientId: string): Promise<ClientRow | null> {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  return row ?? null;
}

/**
 * Authenticates the client at the token or revocation endpoint: HTTP Basic,
 * or client_id (and client_secret) in the body. Public clients send no
 * secret; confidential clients must.
 */
export async function authenticateClient(
  db: DbOrTx,
  body: Record<string, string>,
  authorization: string | undefined,
): Promise<ClientRow> {
  let clientId = body.client_id;
  let secret = body.client_secret;
  const basic = authorization && /^Basic\s+(\S+)$/i.exec(authorization);
  if (basic) {
    const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) throw new OAuthError(401, "invalid_client", "Malformed client credentials");
    try {
      clientId = decodeURIComponent(decoded.slice(0, separator));
      secret = decodeURIComponent(decoded.slice(separator + 1));
    } catch {
      throw new OAuthError(401, "invalid_client", "Malformed client credentials");
    }
  }
  if (!clientId) throw new OAuthError(401, "invalid_client", "Send the client_id");
  const client = await storedClient(db, clientId);
  if (!client) throw new OAuthError(401, "invalid_client", "Unknown client");
  if (client.tokenEndpointAuthMethod !== "none") {
    if (!secret || !client.secretHash || !sameHash(hashToken(secret), client.secretHash)) {
      throw new OAuthError(401, "invalid_client", "Wrong client credentials");
    }
  }
  return client;
}

/**
 * Removes clients that never got a grant (no one connected them) and have
 * no sign-in in progress, a few days after they registered or their
 * metadata document was first read.
 */
export async function pruneUnusedClients(db: DbOrTx) {
  await db.delete(oauthClients).where(
    and(
      lt(oauthClients.createdAt, sql`now() - make_interval(days => ${UNUSED_CLIENT_DAYS})`),
      notExists(
        db
          .select({ one: sql`1` })
          .from(oauthGrants)
          .where(sql`"oauth_grants"."client_id" = "oauth_clients"."id"`),
      ),
      notExists(
        db
          .select({ one: sql`1` })
          .from(oauthRequests)
          .where(sql`"oauth_requests"."client_id" = "oauth_clients"."id"`),
      ),
    ),
  );
}
