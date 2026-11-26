import { and, eq, notInArray, sql } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { logger } from "../logger";

/**
 * Makes every address in ADMIN_EMAILS an admin, so the first person can
 * sign in and set up spaces, and an installation can always be recovered.
 * Addresses taken out of the list lose admin rights given by it.
 */
export async function ensureEnvironmentAdmins(db: Db) {
  const emails = config().adminEmails;
  await db
    .update(users)
    .set({ isAdmin: false, adminSource: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(users.adminSource, "environment"),
        emails.length > 0 ? notInArray(users.email, emails) : sql`true`,
      ),
    );
  for (const email of emails) {
    await db
      .insert(users)
      .values({ email, name: "", isAdmin: true, adminSource: "environment" })
      .onConflictDoUpdate({
        target: users.email,
        set: { isAdmin: true, adminSource: "environment", updatedAt: sql`now()` },
      });
  }
  if (emails.length > 0) logger.info({ count: emails.length }, "admins from ADMIN_EMAILS ensured");
}

export function isEnvironmentAdmin(email: string): boolean {
  return config().adminEmails.includes(email.toLowerCase());
}

/** Startup warnings about sign-in settings that let more people in than intended. */
export function warnAboutOpenSignIn() {
  const settings = config();
  if (settings.allowedEmailDomains.length === 0 && settings.accessGroups.length === 0) {
    logger.warn(
      "everyone the provider lets in may sign in: set ALLOWED_EMAIL_DOMAINS or ACCESS_GROUPS to limit it",
    );
  }
  if (!settings.OIDC_REQUIRE_EMAIL_VERIFIED) {
    logger.warn("OIDC_REQUIRE_EMAIL_VERIFIED is off: email addresses the provider has not verified sign in");
  }
}
