import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { config } from "../config";
import { getDb } from "../db/client";
import { bearerToken, resolvePrincipal } from "../auth/resolve";
import type { Principal, UserPrincipal } from "../auth/principal";
import { logger } from "../logger";
import type { AppEnv } from "./env";
import { AppError, badRequest, forbidden, parseWith, unauthorized } from "./errors";

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};

export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = performance.now();
  await next();
  const path = c.req.path;
  if (path.startsWith("/-/") || path.startsWith("/assets/")) return;
  logger.info(
    {
      requestId: c.get("requestId"),
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    },
    "request",
  );
};

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("principal", await resolvePrincipal(getDb(), c.req.raw.headers));
  await next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cross-site request protection for the browser: changes need an Origin of
 * the application itself. Requests with a bearer token carry no cookies
 * and are exempt.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || bearerToken(c.req.raw.headers)) return next();
  const origin = c.req.header("origin");
  const allowed = new URL(config().APP_URL).origin;
  if (origin ? origin !== allowed : c.req.header("sec-fetch-site") !== "same-origin") {
    throw new AppError(403, "forbidden", "Cross-site request rejected");
  }
  await next();
};

/** Anyone signed in or with a valid token (service tokens included); 401 otherwise. */
export function requirePrincipal(c: Context<AppEnv>): Principal {
  const principal = c.get("principal");
  if (!principal) throw unauthorized();
  return principal;
}

/** A person (web session, personal token or connected app); 401/403 otherwise. */
export function requireUser(c: Context<AppEnv>): UserPrincipal {
  const principal = requirePrincipal(c);
  if (principal.kind !== "user") throw forbidden("Service tokens can only read");
  return principal;
}

/** A person in the web app (not an agent): token and connection management, consent. */
export function requireWebUser(c: Context<AppEnv>): UserPrincipal {
  const principal = requireUser(c);
  if (principal.agent) throw forbidden("Only possible in the web app");
  return principal;
}

/** An admin in the web app. Agents never act as admins. */
export function requireAdmin(c: Context<AppEnv>): UserPrincipal {
  const principal = requireUser(c);
  if (!principal.isAdmin || principal.agent) throw forbidden("Only admins can do this");
  return principal;
}

/** The JSON body validated with a shared schema. */
export async function jsonBody<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("The request body must be JSON");
  }
  return parseWith(schema, body);
}

export function queryOf<T extends z.ZodType>(c: Context<AppEnv>, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query());
}

/** A route parameter that must be a UUID (404 otherwise, like an unknown id). */
export function idParam(c: Context<AppEnv>, name = "id"): string {
  const value = c.req.param(name) ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(404, "not_found", "Not found");
  }
  return value.toLowerCase();
}

/** A change set number in the path (404 for anything else). */
export function numberParam(c: Context<AppEnv>, name = "number"): number {
  const value = c.req.param(name) ?? "";
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new AppError(404, "not_found", "Not found");
  }
  return Number(value);
}
