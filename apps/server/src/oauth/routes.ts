import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { config } from "../config";
import { getDb } from "../db/client";
import { clientIp } from "../http/client-ip";
import type { AppEnv } from "../http/env";
import { logger } from "../logger";
import { authenticateClient, OAuthError, registerClient } from "./clients";
import {
  AuthorizePageError,
  exchangeCode,
  refreshTokens,
  isOurResource,
  revokeToken,
  SCOPE,
  startAuthorization,
} from "./flow";
import { OAUTH_RATE_LIMITS, RateLimiter, rateLimitKey } from "./rate-limit";

/**
 * The OAuth 2.1 authorization server for connected apps (MCP clients):
 * /.well-known metadata, /oauth/register, /oauth/authorize, /oauth/token
 * and /oauth/revoke (docs/architecture.md, "OAuth server").
 */

/** Any origin, no cookies: for apps that call from a browser (MCP inspectors, web clients). */
export const publicCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
  exposeHeaders: ["www-authenticate", "mcp-session-id"],
  maxAge: 86_400,
});

export function protectedResourceMetadata() {
  const settings = config();
  return {
    resource: settings.mcpUrl,
    authorization_servers: [settings.APP_URL],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: settings.APP_NAME,
    resource_documentation: `${settings.APP_URL}/settings`,
  };
}

export function authorizationServerMetadata() {
  const base = config().APP_URL;
  const methods = ["none", "client_secret_post", "client_secret_basic"];
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: methods,
    revocation_endpoint_auth_methods_supported: methods,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/settings`,
  };
}

function oauthError(c: Context<AppEnv>, error: OAuthError, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "cache-control": "no-store", ...extraHeaders };
  if (error.status === 401) headers["www-authenticate"] = 'Basic realm="oauth"';
  return c.json({ error: error.error, error_description: error.description }, error.status, headers);
}

async function formBody(c: Context<AppEnv>) {
  const json = c.req.header("content-type")?.includes("application/json");
  let raw: Record<string, unknown>;
  if (json) {
    raw = ((await c.req.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  } else {
    raw = (await c.req.parseBody({ all: true }).catch(() => ({}))) as Record<string, unknown>;
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = !json && Array.isArray(value) ? value.at(-1) : value;
    if (typeof field === "string") fields[key] = field;
  }
  // RFC 8707 lets clients repeat resource. Check every value, even if the last one matches.
  return { fields, resources: [raw.resource ?? []].flat() };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function errorPage(
  c: Context<AppEnv>,
  message: string,
  status: ContentfulStatusCode = 400,
  headers: Record<string, string> = {},
) {
  const name = escapeHtml(config().APP_NAME);
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}: cannot connect</title></head>` +
      `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">` +
      `<h1 style="font-size: 1.25rem">The app cannot connect to ${name}</h1><p>${escapeHtml(message)}</p></body></html>`,
    status,
    headers,
  );
}

const limiters = {
  register: new RateLimiter(OAUTH_RATE_LIMITS.register),
  authorize: new RateLimiter(OAUTH_RATE_LIMITS.authorize),
  token: new RateLimiter(OAUTH_RATE_LIMITS.token),
  revoke: new RateLimiter(OAUTH_RATE_LIMITS.revoke),
} satisfies Record<keyof typeof OAUTH_RATE_LIMITS, RateLimiter>;

/** Tests only: forget what the rate limits counted. */
export function resetRateLimitsForTests() {
  for (const limiter of Object.values(limiters)) limiter.clear();
}

/** Refuses a client address's requests beyond `name`'s limit with 429: a JSON error, or a page for browsers. */
function rateLimited(name: keyof typeof OAUTH_RATE_LIMITS, page = false): MiddlewareHandler<AppEnv> {
  const limiter = limiters[name];
  return async (c, next) => {
    const wait = limiter.take(rateLimitKey(clientIp(c)));
    if (!wait) return next();
    const headers = { "retry-after": String(wait) };
    if (page)
      return errorPage(
        c,
        "Too many sign-in attempts from your network. Try again in a few minutes.",
        429,
        headers,
      );
    return oauthError(
      c,
      new OAuthError(429, "temporarily_unavailable", "Too many requests. Try again later."),
      headers,
    );
  };
}

export function oauthRoutes() {
  const app = new Hono<AppEnv>();
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/*",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/*",
    "/oauth/register",
    "/oauth/token",
    "/oauth/revoke",
  ]) {
    app.use(path, publicCors);
  }
  app.use("/oauth/register", bodyLimit({ maxSize: 16 * 1024 }));
  app.use("/oauth/token", bodyLimit({ maxSize: 16 * 1024 }));
  app.use("/oauth/revoke", bodyLimit({ maxSize: 16 * 1024 }));

  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata()));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata()));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata()));

  app.post("/oauth/register", rateLimited("register"), async (c) => {
    try {
      const body: unknown = await c.req.json().catch(() => null);
      return c.json(await registerClient(getDb(), body), 201, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error);
      throw error;
    }
  });

  app.get("/oauth/authorize", rateLimited("authorize", true), async (c) => {
    try {
      return c.redirect(
        await startAuthorization(getDb(), c.req.query(), c.req.queries("resource") ?? []),
        302,
      );
    } catch (error) {
      if (error instanceof AuthorizePageError) return errorPage(c, error.message, error.status);
      throw error;
    }
  });

  app.post("/oauth/token", rateLimited("token"), async (c) => {
    try {
      const { fields: body, resources } = await formBody(c);
      const client = await authenticateClient(getDb(), body, c.req.header("authorization"));
      if (
        resources.some((resource) => typeof resource !== "string" || (resource && !isOurResource(resource)))
      ) {
        throw new OAuthError(400, "invalid_target", "Unknown resource");
      }
      const grantType = body.grant_type;
      let tokens;
      if (grantType === "authorization_code") tokens = await exchangeCode(getDb(), client, body);
      else if (grantType === "refresh_token") tokens = await refreshTokens(getDb(), client, body);
      else throw new OAuthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
      return c.json(tokens, 200, { "cache-control": "no-store", pragma: "no-cache" });
    } catch (error) {
      if (error instanceof OAuthError) {
        if (error.error !== "invalid_grant") logger.info({ error: error.error }, "token request refused");
        return oauthError(c, error);
      }
      throw error;
    }
  });

  app.post("/oauth/revoke", rateLimited("revoke"), async (c) => {
    try {
      const { fields: body } = await formBody(c);
      const client = await authenticateClient(getDb(), body, c.req.header("authorization"));
      await revokeToken(getDb(), client, body.token);
      return c.body(null, 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error);
      throw error;
    }
  });

  return app;
}
