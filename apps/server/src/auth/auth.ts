import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/client";
import { accounts, authRateLimits, sessions, users, verifications } from "../db/schema";
import { CLIENT_IP_HEADER } from "../http/client-ip";
import { logger } from "../logger";
import { checkAccessAtSignIn, checkProviderUserInfo } from "./sign-in";

/**
 * Sign-in only through the OpenID Connect provider. Anyone the provider
 * knows may try; the provider must vouch for the email address
 * (`checkProviderUserInfo`), and a session starts only when
 * `checkAccessAtSignIn` allows it (not blocked, allowed email domain and
 * groups).
 */
function createAuth() {
  const settings = config();
  const appUrl = new URL(settings.APP_URL);
  return betterAuth({
    appName: settings.APP_NAME,
    baseURL: settings.APP_URL,
    basePath: "/api/auth",
    secret: settings.AUTH_SECRET,
    trustedOrigins: [settings.APP_URL],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: authRateLimits,
      },
    }),
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: "handbook",
      useSecureCookies: appUrl.protocol === "https:",
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    emailAndPassword: { enabled: false },
    session: {
      // Sessions end SESSION_DAYS after sign-in, used or not: access is
      // checked again at the next sign-in.
      expiresIn: 60 * 60 * 24 * settings.SESSION_DAYS,
      disableSessionRefresh: true,
      // Short cache: losing access takes effect within a minute.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    user: {
      // Before a person is created, linked or signed in: the provider must
      // vouch for the email address.
      validateUserInfo: ({ user }) => checkProviderUserInfo(user),
    },
    account: {
      // A space owner (or ADMIN_EMAILS) may name a person by email before
      // their first sign-in, which links the provider's account to that
      // entry. Only an address the provider verified links, unless
      // OIDC_REQUIRE_EMAIL_VERIFIED is off: then the provider is trusted.
      accountLinking: {
        enabled: true,
        trustedProviders: settings.OIDC_REQUIRE_EMAIL_VERIFIED ? [] : ["oidc"],
        allowDifferentEmails: false,
        requireLocalEmailVerified: false,
        updateUserInfoOnLink: true,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      // Starting a sign-in only redirects to the provider (no passwords here).
      // The default of 3 per 10 seconds would lock out an office whose people
      // share one public address and sign in at nine.
      customRules: { "/sign-in/social": { window: 60, max: 60 } },
    },
    hooks: {
      // Sign-in only through the provider's redirect (authorization code
      // flow), never with an ID token the browser sends.
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/sign-in/social" &&
          (ctx.body as { idToken?: unknown } | undefined)?.idToken !== undefined
        ) {
          throw new APIError("BAD_REQUEST", {
            code: "id_token_sign_in",
            message: "Sign in through the provider",
          });
        }
      }),
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: "oidc",
            discoveryUrl: `${settings.OIDC_ISSUER.replace(/\/+$/, "")}/.well-known/openid-configuration`,
            clientId: settings.OIDC_CLIENT_ID,
            clientSecret: settings.OIDC_CLIENT_SECRET,
            scopes: settings.OIDC_SCOPES.split(/\s+/).filter(Boolean),
            pkce: settings.OIDC_PKCE,
            // Anyone may sign in; the session hook below checks access.
            disableImplicitSignUp: false,
            // Name and picture follow the provider at every sign-in.
            overrideUserInfo: true,
          },
        ],
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          // Access is checked at every sign-in; no access, no session.
          before: async (session) => {
            if (!(await checkAccessAtSignIn(session.userId))) return false;
            return { data: session };
          },
          after: async (session) => {
            await getDb()
              .update(users)
              .set({ lastSignInAt: sql`now()` })
              .where(eq(users.id, session.userId))
              .catch((error: unknown) => logger.warn({ err: error }, "could not record the sign-in time"));
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** The authentication library instance (created on first use, after configuration loads). */
export function auth(): Auth {
  instance ??= createAuth();
  return instance;
}

/** Tests only: build the instance again after changing the configuration. */
export function resetAuthForTests() {
  instance = undefined;
}
