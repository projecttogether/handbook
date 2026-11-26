import os from "node:os";
import path from "node:path";

/**
 * Environment of every test process. Integration tests use TEST_DATABASE_URL
 * (default: the handbook_test database of compose.dev.yaml).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://handbook:handbook@localhost:55450/handbook_test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_URL = "http://localhost:3000";
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-1234";
process.env.LOG_LEVEL = "silent";
process.env.OIDC_ISSUER ??= "http://localhost:8104/realms/handbook";
process.env.OIDC_CLIENT_ID ??= "handbook";
process.env.OIDC_CLIENT_SECRET ??= "test-client-secret";
process.env.ADMIN_EMAILS ??= "root@example.org";
process.env.SEARCH_LANGUAGES ??= "english,german";
process.env.FILES_DIR ??= path.join(os.tmpdir(), `handbook-test-${process.pid}`);
