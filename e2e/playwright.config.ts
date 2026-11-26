import { defineConfig, devices } from "@playwright/test";

/*
 * End-to-end tests: a real browser against the built app (npm run build),
 * signing in through the Keycloak of compose.dev.yaml. The app gets a fresh
 * database, handbook_e2e.
 */
const PORT = 3000;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "../playwright-report" }]]
    : [["list"]],
  outputDir: "../test-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "en-US",
  },
  webServer: {
    command:
      "node e2e/reset-database.mjs && node --import ./apps/server/dist/instrument.mjs ./apps/server/dist/main.mjs",
    cwd: "..",
    url: `http://localhost:${PORT}/-/readyz`,
    timeout: 90_000,
    reuseExistingServer: false,
    stdout: "pipe",
    env: {
      NODE_ENV: "production",
      PORT: String(PORT),
      APP_URL: `http://localhost:${PORT}`,
      DATABASE_URL: "postgres://handbook:handbook@localhost:55450/handbook_e2e",
      RUN_MIGRATIONS: "true",
      AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e-secret",
      OIDC_ISSUER: "http://localhost:8104/realms/handbook",
      OIDC_CLIENT_ID: "handbook",
      OIDC_CLIENT_SECRET: "handbook-dev-client-secret",
      OIDC_PROVIDER_NAME: "Keycloak",
      ADMIN_EMAILS: "ada@example.org",
      ACCESS_GROUPS: "/staff",
      SEARCH_LANGUAGES: "english,german",
      FILES_DIR: "test-results/files",
      WEB_DIST_DIR: "apps/web/dist",
      LOG_LEVEL: "warn",
    },
  },
});
