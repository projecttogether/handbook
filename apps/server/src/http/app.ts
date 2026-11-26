import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import type { AppEnv } from "./env";
import { AppError, databaseErrorCode, zodFieldErrors } from "./errors";
import { authenticate, requestId, requestLog, sameOrigin } from "./middleware";
import { compression } from "./compression";
import { webApp } from "./static";
import { auth } from "../auth/auth";
import { CLIENT_IP_HEADER, clientIp } from "./client-ip";
import { API_MODULES } from "../modules";
import health from "../modules/health";
import { logger } from "../logger";
import { errorReportingSources, tracingMiddleware } from "../error-reporting";
import { config } from "../config";
import { mcpRoutes } from "../mcp/routes";
import { oauthRoutes } from "../oauth/routes";
import { rawRoutes } from "./raw";

/**
 * The routes of the authentication library that the web app and the
 * provider's redirect use; its other routes (profile changes, tokens,
 * account links, …) are not served.
 */
const AUTH_ROUTES = new Set([
  "POST /api/auth/sign-in/social",
  "GET /api/auth/callback/oidc",
  "POST /api/auth/sign-out",
  "GET /api/auth/error",
]);

/**
 * PostgreSQL errors of a request that ran into another one at the same time:
 * unique violation (e.g. two creates at one path), deadlock, serialization
 * failure. Trying again gives the right answer.
 */
const CONCURRENT_CHANGE_CODES = new Set(["23505", "40P01", "40001"]);

/**
 * PostgreSQL refuses text it cannot store: a NUL character in a search, a
 * path or a page (SQLSTATE 22021), or in a JSON column such as a property's
 * label (22P05). The request is wrong, not the server.
 */
const UNSTORABLE_TEXT_CODES = new Set(["22021", "22P05"]);

/**
 * A 409 for a request that ran into a concurrent change; null for other
 * errors. The database's message names constraints and values, so the
 * response leaves it out.
 */
export function concurrentChangeResponse(error: Error, c: Context<AppEnv>) {
  const code = databaseErrorCode(error);
  if (!code || !CONCURRENT_CHANGE_CODES.has(code)) return null;
  logger.warn(
    { err: error, requestId: c.get("requestId"), route: `${c.req.method} ${c.req.routePath}`, code },
    "request ran into a concurrent change",
  );
  return c.json(
    {
      error: { code: "concurrent_change", message: "Someone else changed this at the same time. Try again." },
    },
    409,
  );
}

export function createApp() {
  const app = new Hono<AppEnv>();
  const tracing = tracingMiddleware(app);
  if (tracing) app.use("*", tracing);
  app.use("*", requestId, requestLog, compression());
  // Uploaded files never run anything in the app's origin: a stricter policy
  // than the app's replaces it (this runs after secureHeaders below).
  app.use("/files/*", async (c, next) => {
    await next();
    c.res.headers.set("content-security-policy", "sandbox; default-src 'none'");
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", ...errorReportingSources()],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { ...error.extra, error: { code: error.code, message: error.message, fields: error.fields } },
        error.status,
      );
    }
    if (error instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "validation_error",
            message: "Check the highlighted fields",
            fields: zodFieldErrors(error),
          },
        },
        422,
      );
    }
    if (error instanceof HTTPException) {
      return c.json(
        {
          error: { code: error.status === 413 ? "payload_too_large" : "bad_request", message: error.message },
        },
        error.status,
      );
    }
    const concurrent = concurrentChangeResponse(error, c);
    if (concurrent) return concurrent;
    if (UNSTORABLE_TEXT_CODES.has(databaseErrorCode(error) ?? "")) {
      return c.json(
        { error: { code: "bad_request", message: "The text has a character that cannot be saved (NUL)." } },
        400,
      );
    }
    logger.error(
      { err: error, requestId: c.get("requestId"), route: `${c.req.method} ${c.req.routePath}` },
      "unhandled error",
    );
    return c.json({ error: { code: "internal_error", message: "Something went wrong. Try again." } }, 500);
  });

  app.route("/", health);

  // Sign-in and sign-out send only small browser forms or JSON bodies.
  app.post("/api/auth/*", bodyLimit({ maxSize: 64 * 1024 }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    if (!AUTH_ROUTES.has(`${c.req.method} ${c.req.path}`)) {
      return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    }
    // Replace any client-supplied value with the address the app trusts.
    const headers = new Headers(c.req.raw.headers);
    headers.set(CLIENT_IP_HEADER, clientIp(c) ?? "unknown");
    const body = c.req.method === "GET" ? undefined : c.req.raw.body;
    return auth().handler(
      new Request(c.req.raw.url, {
        method: c.req.method,
        headers,
        body,
        duplex: "half",
        signal: c.req.raw.signal,
      } as RequestInit),
    );
  });

  // Connected apps (MCP clients) talk OAuth and MCP from other origins.
  // /mcp reads bearer tokens itself; session cookies do not count there.
  app.route("/", oauthRoutes());
  app.route(
    "/mcp",
    mcpRoutes((request, env) => app.fetch(request, env)),
  );

  const api = new Hono<AppEnv>();
  // API responses can carry private content and newly issued credentials.
  api.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  const uploadLimit = bodyLimit({ maxSize: config().MAX_UPLOAD_MB * 1024 * 1024 + 64 * 1024 });
  const jsonLimit = bodyLimit({ maxSize: 2 * 1024 * 1024 });
  api.use(
    "*",
    (c, next) => {
      if (c.req.method === "POST" && c.req.path.endsWith("/files")) return uploadLimit(c, next);
      return jsonLimit(c, next);
    },
    sameOrigin,
    authenticate,
  );
  for (const module of API_MODULES) api.route("/", module);
  app.route("/api/v1", api);
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  app.use("/files/*", authenticate);
  app.use("/s/*", authenticate);
  app.use("/llms.txt", authenticate);
  app.route("/", rawRoutes());

  app.route("/", webApp());
  return app;
}
