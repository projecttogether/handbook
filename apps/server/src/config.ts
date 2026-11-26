import { z } from "zod";

/**
 * Settings from the environment. Read them only through `config()`; blank
 * values count as unset. Document every variable in docs/configuration.md.
 * Everything else (spaces, editors, properties) is set up in the app.
 */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess(blankToUndefined, schema.default(fallback as never));
const flag = (fallback: boolean) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() !== ""
        ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
        : undefined,
    z.boolean().default(fallback),
  );

/** Example values of AUTH_SECRET (.env.example, older docs): never valid where the app is in use. */
const EXAMPLE_SECRETS = new Set([
  "change-me-to-a-long-random-value",
  "development-secret-development-secret",
]);
const TEXT_SEARCH_CONFIG = /^[a-z_]+$/;

const schema = z
  .object({
    NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "development"),
    /** Which part of the application this process runs. */
    APP_ROLE: withDefault(z.enum(["all", "web", "worker", "migrate"]), "all"),
    PORT: withDefault(z.coerce.number().int().min(1).max(65535), 3000),
    HOST: withDefault(z.string(), "0.0.0.0"),
    /** The public URL of the app, e.g. https://handbook.example.org */
    APP_URL: withDefault(z.url(), "http://localhost:3000"),
    APP_NAME: withDefault(z.string().min(1).max(100), "Handbook"),
    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_SIZE: withDefault(z.coerce.number().int().min(1).max(200), 10),
    /** Longest database statement of the web app and the worker, in seconds; 0: no limit. */
    DATABASE_STATEMENT_TIMEOUT_SECONDS: withDefault(z.coerce.number().int().min(0).max(86_400), 60),
    /** Signs sessions. At least 32 characters. */
    AUTH_SECRET: z.string().min(32),
    LOG_LEVEL: withDefault(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]), "info"),
    /**
     * Reverse proxies in front of the app that append to X-Forwarded-For:
     * `true` (one), a number of hops, or `false`/0 (use the socket address).
     */
    TRUST_PROXY: z.preprocess((value) => {
      if (typeof value !== "string" || value.trim() === "") return undefined;
      const text = value.trim().toLowerCase();
      if (["true", "yes", "on"].includes(text)) return 1;
      if (["false", "no", "off"].includes(text)) return 0;
      return text;
    }, z.coerce.number().int().min(0).max(10).default(0)),
    /** Apply database migrations when the process starts (single-container setups). */
    RUN_MIGRATIONS: flag(false),
    /** Directory with the built web app. */
    WEB_DIST_DIR: optional(z.string()),
    MIGRATIONS_DIR: optional(z.string()),
    /** Where uploaded files are stored. Keep it on a volume and in backups. */
    FILES_DIR: withDefault(z.string(), ".data/files"),
    /** Sign-in with an OpenID Connect provider (Keycloak, Microsoft Entra ID, Google, Authentik, …). */
    OIDC_ISSUER: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    OIDC_PROVIDER_NAME: withDefault(z.string().max(40), "single sign-on"),
    OIDC_SCOPES: withDefault(z.string(), "openid email profile"),
    /** Proof Key for Code Exchange; turn off only for providers that reject it. */
    OIDC_PKCE: flag(true),
    /** The claim with a person's groups, for ACCESS_GROUPS. A dotted name reads a nested claim. */
    OIDC_GROUPS_CLAIM: withDefault(z.string().min(1).max(100), "groups"),
    /** Comma-separated email addresses that are always admins (first setup and recovery). */
    ADMIN_EMAILS: withDefault(z.string(), ""),
    /** Comma-separated email domains that may sign in; empty: every address the provider vouches for. */
    ALLOWED_EMAIL_DOMAINS: withDefault(z.string(), ""),
    /** Comma-separated groups (from OIDC_GROUPS_CLAIM) of which a person must be in one; empty: no check. */
    ACCESS_GROUPS: withDefault(z.string(), ""),
    /**
     * Sign in only when the provider says the email address is verified
     * (claim `email_verified`). Turn off only for providers that do not send
     * the claim (Microsoft Entra ID) and where people cannot choose their address.
     */
    OIDC_REQUIRE_EMAIL_VERIFIED: flag(true),
    /** Sessions end this many days after sign-in; using the app does not extend them. */
    SESSION_DAYS: withDefault(z.coerce.number().int().min(1).max(90), 7),
    /**
     * Personal tokens and connected apps stop working when their person has
     * not signed in through the provider for this many days; 0: no limit.
     */
    AGENT_SIGN_IN_DAYS: withDefault(z.coerce.number().int().min(0).max(365), 30),
    /**
     * PostgreSQL text search configurations for search, comma-separated, e.g.
     * `english,german`. Word forms ("laptops" finds "laptop") follow them;
     * exact words always match.
     */
    SEARCH_LANGUAGES: withDefault(z.string(), "english"),
    /** Lifetime of access tokens of connected apps (OAuth, MCP), in minutes. */
    OAUTH_ACCESS_TOKEN_MINUTES: withDefault(z.coerce.number().int().min(5).max(1440), 60),
    /** Lifetime of refresh tokens of connected apps, in days; each use renews it. */
    OAUTH_REFRESH_TOKEN_DAYS: withDefault(z.coerce.number().int().min(1).max(365), 30),
    /**
     * Development and tests only: let connected apps register with client
     * metadata documents on private addresses (e.g. localhost).
     */
    OAUTH_ALLOW_PRIVATE_CLIENT_URLS: flag(false),
    /** Largest file upload, in megabytes. */
    MAX_UPLOAD_MB: withDefault(z.coerce.number().int().min(1).max(500), 20),
    /** Days the audit log keeps entries; the worker deletes older ones. 0 keeps them all. */
    AUDIT_LOG_DAYS: withDefault(z.coerce.number().int().min(0).max(36_500), 365),
    /** The worker touches this file every few seconds, for container health checks. */
    WORKER_HEARTBEAT_FILE: optional(z.string()),
    /**
     * The version: the commit an image was built from (its first 12
     * characters), set by the Deploy workflow; unset in images built from source.
     */
    APP_VERSION: optional(z.string().max(100)),
    /** Error reports and performance data to Sentry or a compatible service; off when unset. */
    SENTRY_DSN: optional(z.url()),
    SENTRY_ENVIRONMENT: optional(z.string().max(64)),
    SENTRY_RELEASE: optional(z.string().max(200)),
    /** Share of requests and page loads traced for performance data, 0 to 1. */
    SENTRY_TRACES_SAMPLE_RATE: withDefault(z.coerce.number().min(0).max(1), 0),
  })
  .superRefine((value, ctx) => {
    // A copied .env.example sets NODE_ENV=development: an https address counts too.
    const deployed = value.NODE_ENV === "production" || /^https:/i.test(value.APP_URL);
    if (deployed && EXAMPLE_SECRETS.has(value.AUTH_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_SECRET"],
        message: "Replace the example value (openssl rand -base64 32)",
      });
    }
    if (value.AGENT_SIGN_IN_DAYS > 0 && value.AGENT_SIGN_IN_DAYS < value.SESSION_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["AGENT_SIGN_IN_DAYS"],
        message: "Use 0 or at least SESSION_DAYS",
      });
    }
    for (const email of splitList(value.ADMIN_EMAILS)) {
      if (!z.email().safeParse(email).success) {
        ctx.addIssue({ code: "custom", path: ["ADMIN_EMAILS"], message: `Not an email address: ${email}` });
      }
    }
    for (const domain of splitList(value.ALLOWED_EMAIL_DOMAINS)) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
        ctx.addIssue({ code: "custom", path: ["ALLOWED_EMAIL_DOMAINS"], message: `Not a domain: ${domain}` });
      }
    }
    for (const language of splitList(value.SEARCH_LANGUAGES)) {
      if (!TEXT_SEARCH_CONFIG.test(language)) {
        ctx.addIssue({
          code: "custom",
          path: ["SEARCH_LANGUAGES"],
          message: `Not a text search configuration: ${language}`,
        });
      }
    }
    if (value.OAUTH_ALLOW_PRIVATE_CLIENT_URLS && deployed) {
      ctx.addIssue({
        code: "custom",
        path: ["OAUTH_ALLOW_PRIVATE_CLIENT_URLS"],
        message: "Only for development and tests",
      });
    }
  });

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export type Config = z.infer<typeof schema> & {
  adminEmails: string[];
  allowedEmailDomains: string[];
  accessGroups: string[];
  /** Text search configurations, always ending with `simple` (exact words). */
  searchConfigs: string[];
  /** The MCP endpoint, e.g. https://handbook.example.org/mcp */
  mcpUrl: string;
};

let cached: Config | undefined;

/** Missing or invalid variables: `variables` names them; the message can quote their values. */
export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(
    readonly variables: string[],
    problems: string,
  ) {
    super(`Invalid configuration:\n${problems}`);
  }
}

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError([...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))], problems);
  }
  const value = parsed.data;
  const appUrl = value.APP_URL.replace(/\/+$/, "");
  const languages = splitList(value.SEARCH_LANGUAGES).filter((language) => language !== "simple");
  cached = {
    ...value,
    APP_URL: appUrl,
    adminEmails: splitList(value.ADMIN_EMAILS),
    allowedEmailDomains: splitList(value.ALLOWED_EMAIL_DOMAINS),
    accessGroups: value.ACCESS_GROUPS.split(",")
      .map((group) => group.trim())
      .filter(Boolean),
    searchConfigs: [...new Set(languages), "simple"],
    mcpUrl: `${appUrl}/mcp`,
  };
  return cached;
}

/** Tests only: forget the cached configuration after changing process.env. */
export function resetConfigForTests() {
  cached = undefined;
}
