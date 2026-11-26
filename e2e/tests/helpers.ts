import { expect, type Browser, type Page } from "@playwright/test";

export const PASSWORD = "handbook-dev";
export const APP = "http://localhost:3000";

/** Signs in through Keycloak in a fresh browser context; returns its page. */
export async function signIn(browser: Browser, user: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Keycloak" }).click();
  await page.locator("#username").fill(`${user}@example.org`);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#kc-login").click();
  return page;
}

/** A JSON API call with the page's session, as the web app makes it. */
export async function apiCall<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(`/api/v1${path}`, {
    method,
    data,
    headers: { origin: APP, accept: "application/json" },
  });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
