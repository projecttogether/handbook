import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { APP, apiCall, signIn } from "./helpers";

/*
 * The main flows in a real browser, signing in through Keycloak:
 * an admin sets up a space, an editor writes, a reader suggests a change,
 * the editor merges it, edit locks keep two people apart, and an agent
 * connects through OAuth and works in a change set.
 */
test.describe.configure({ mode: "serial" });

async function home(page: Page) {
  await page.waitForURL(`${APP}/`);
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();
}

async function mcp(token: string, method: string, params: unknown) {
  const response = await fetch(`${APP}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result: { structuredContent?: Record<string, unknown>; tools?: unknown[] };
  };
}

test("an admin creates a space and names an editor", async ({ browser }) => {
  const ada = await signIn(browser, "ada");
  await home(ada);
  // The sidebar's "Spaces" under Administration (the spaces themselves are a group, not a link).
  await ada
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Spaces", exact: true })
    .click();
  await ada.getByRole("button", { name: "New space" }).first().click();
  const dialog = ada.getByRole("dialog");
  await dialog.getByLabel(/^Name/).fill("IT and devices");
  await dialog.getByLabel(/URL/).fill("it");
  await dialog.getByLabel(/Description/).fill("Devices, accounts and how to get help.");
  await dialog.getByRole("radio", { name: /^IT/ }).click();
  await dialog.getByRole("button", { name: /Create/ }).click();
  await ada.waitForURL(/\/s\/it\/-\/settings/);

  await ada.getByPlaceholder("name@example.org").fill("eddie@example.org");
  await ada.getByRole("button", { name: "Add", exact: true }).click();
  await expect(ada.getByText("eddie@example.org").first()).toBeVisible();

  // The IT template brought its page types; owners change them like anything else.
  const troubleshooting = ada.getByRole("group", { name: "Troubleshooting" });
  await troubleshooting.getByLabel(/What pages of this type are for/).fill("One problem and its fix.");
  const response = ada.waitForResponse(
    (r) => r.url().endsWith("/api/v1/spaces/it") && r.request().method() === "PATCH",
  );
  await ada.getByRole("button", { name: "Save" }).nth(2).click();
  expect((await response).ok()).toBe(true);
  await expect(ada.getByRole("link", { name: "IT and devices" }).first()).toBeVisible();
  // And its section pages.
  await ada.goto("/s/it");
  await expect(ada.getByRole("link", { name: "Onboarding and offboarding" }).first()).toBeVisible();
});

test("people outside the access groups cannot sign in", async ({ browser }) => {
  const gina = await signIn(browser, "gina");
  await gina.waitForURL(/\/sign-in\?error=/);
  await expect(gina.getByText("This account has no access")).toBeVisible();
});

test("an admin writes a page in Markdown with properties", async ({ browser }) => {
  const ada = await signIn(browser, "ada");
  await home(ada);
  await ada.goto("/s/it/-/new");
  await ada.getByLabel("Title").fill("Request a laptop");
  // Page types are cards to start from; choosing one fills in its template.
  await ada.getByRole("radio", { name: /How-to/ }).click();
  await ada.getByRole("button", { name: "Page settings" }).click();
  await ada.getByLabel("Tags").fill("hardware, onboarding");
  await ada.keyboard.press("Escape");
  // The whole file as Markdown.
  await ada.getByRole("button", { name: "Markdown" }).click();
  await ada.locator(".cm-content").first().click();
  await ada.keyboard.press("Control+End");
  await ada.keyboard.type("\n> [!TIP]\nAsk two weeks before the start date.");
  await ada.getByRole("button", { name: "Create page" }).click();
  await ada.waitForURL(/\/s\/it\/request-a-laptop$/);
  await expect(ada.getByRole("heading", { name: "Request a laptop" })).toBeVisible();
  await expect(ada.getByText("Tip", { exact: true })).toBeVisible();
  await expect(ada.getByText("onboarding")).toBeVisible();

  const file = await ada.request.get("/s/it/request-a-laptop.md");
  expect(await file.text()).toContain(
    "title: Request a laptop\ntype: how-to\ntags:\n  - hardware\n  - onboarding\n",
  );
});

test("a reader suggests a change and an editor merges it", async ({ browser }) => {
  const rita = await signIn(browser, "rita");
  await home(rita);
  await rita.goto("/s/it/request-a-laptop");
  await expect(rita.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  await rita.getByRole("link", { name: "Suggest an edit" }).click();
  await rita.waitForURL(/\/edit\?changeSet=new/);
  // The template's empty first step, in rich text.
  await rita.locator(".ProseMirror ol > li").first().click();
  await rita.keyboard.press("End");
  await rita.keyboard.type("Open a request in the helpdesk with your start date.");
  await rita.getByRole("button", { name: "Save suggestion" }).click();
  const dialog = rita.getByRole("dialog");
  await dialog.getByLabel("Title").fill("Add the first step");
  await dialog.getByRole("button", { name: "Send for review" }).click();
  await rita.waitForURL(/\/changes\/\d+$/);
  const number = rita.url().split("/").at(-1)!;
  // Sent for review with the dialog: no second step.
  await expect(rita.getByText("In review").first()).toBeVisible();
  await expect(rita.getByRole("button", { name: "Submit for review" })).toHaveCount(0);
  await expect(rita.getByRole("button", { name: "Merge" })).toHaveCount(0);

  const eddie = await signIn(browser, "eddie");
  await home(eddie);
  // The editor finds it on the start page.
  await eddie.getByRole("link", { name: `#${number} Add the first step` }).click();
  await eddie.waitForURL(new RegExp(`/changes/${number}$`));
  await eddie.getByRole("button", { name: "Merge" }).click();
  const confirm = eddie.getByRole("alertdialog");
  if (await confirm.isVisible().catch(() => false))
    await confirm.getByRole("button", { name: "Merge" }).click();
  await expect(eddie.getByText("Merged").first()).toBeVisible();
  await eddie.goto("/s/it/request-a-laptop");
  await expect(eddie.getByText("Open a request in the helpdesk with your start date.")).toBeVisible();
});

test("only one person edits a page at a time", async ({ browser }) => {
  const eddie = await signIn(browser, "eddie");
  await home(eddie);
  await eddie.goto("/s/it/request-a-laptop");
  await eddie.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(eddie.locator(".ProseMirror")).toBeVisible();

  const ada = await signIn(browser, "ada");
  await home(ada);
  await ada.goto(eddie.url());
  await expect(ada.getByText("Someone else is editing this page")).toBeVisible();
  await expect(ada.getByText(/Eddie Editor started editing this page/)).toBeVisible();
  await expect(ada.getByRole("button", { name: "Take over" })).toBeVisible();
  await eddie.getByRole("button", { name: "Cancel" }).click();
});

test("an editor writes in rich text and the rest of the Markdown stays as written", async ({ browser }) => {
  const eddie = await signIn(browser, "eddie");
  await home(eddie);
  const before = await (await eddie.request.get("/s/it/request-a-laptop.md")).text();
  await eddie.goto("/s/it/request-a-laptop");
  await eddie.getByRole("link", { name: "Edit", exact: true }).click();
  const editor = eddie.locator(".ProseMirror");
  await editor.locator("h2", { hasText: "Result" }).click();
  await eddie.keyboard.press("End");
  await eddie.keyboard.press("Enter");
  // The / menu inserts blocks.
  await eddie.keyboard.type("/callout");
  await expect(eddie.getByRole("option", { name: /Callout/ })).toBeVisible();
  await eddie.keyboard.press("Enter");
  await eddie.keyboard.type("You get the laptop on your first day.");
  await eddie.getByRole("button", { name: "Save", exact: true }).click();
  await eddie.getByLabel("Note about this change (optional)").fill("Say when the laptop arrives");
  await eddie.getByRole("button", { name: "Save page" }).click();
  await eddie.waitForURL(/\/s\/it\/request-a-laptop$/);
  await expect(eddie.getByText("You get the laptop on your first day.")).toBeVisible();

  const after = await (await eddie.request.get("/s/it/request-a-laptop.md")).text();
  expect(after).toBe(
    before.replace("## Result\n\n", "## Result\n\n> [!NOTE]\n> You get the laptop on your first day.\n\n"),
  );
});

test("an agent connects with OAuth and proposes a change set", async ({ browser }) => {
  const metadata = (await fetch(`${APP}/.well-known/oauth-authorization-server`).then((r) => r.json())) as {
    registration_endpoint: string;
    authorization_endpoint: string;
    token_endpoint: string;
  };
  const redirect = "http://localhost:9999/callback";
  const client = (await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Assistant",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    }),
  }).then((r) => r.json())) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(metadata.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "e2e",
    resource: `${APP}/mcp`,
  })) {
    authorize.searchParams.set(key, value);
  }

  const rita = await signIn(browser, "rita");
  await home(rita);
  let callback = "";
  await rita.route("http://localhost:9999/**", (route) => {
    callback = route.request().url();
    return route.fulfill({ status: 200, body: "ok" });
  });
  await rita.goto(authorize.toString());
  await expect(rita.getByRole("heading", { name: "Connect Test Assistant?" })).toBeVisible();
  await rita.getByRole("button", { name: "Connect" }).click();
  await rita.waitForURL(/localhost:9999/);
  const code = new URL(callback).searchParams.get("code")!;
  expect(new URL(callback).searchParams.get("state")).toBe("e2e");

  const tokens = (await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: client.client_id,
      code_verifier: verifier,
    }),
  }).then((r) => r.json())) as { access_token: string };

  const call = async (name: string, args: Record<string, unknown>) =>
    (await mcp(tokens.access_token, "tools/call", { name, arguments: args })).result.structuredContent!;
  const started = await call("start_change_set", { space: "it", title: "Add a VPN page" });
  const number = started.changeSet as number;
  await call("create_page", {
    change_set: number,
    page: "it/vpn",
    markdown: "---\ntitle: VPN\n---\n\nConnect from home.\n",
  });
  await call("submit_change_set", { change_set: number });

  const eddie = await signIn(browser, "eddie");
  await home(eddie);
  await eddie.goto(`/changes/${number}`);
  await expect(eddie.getByText("Test Assistant").first()).toBeVisible();
  await expect(eddie.getByText("VPN").first()).toBeVisible();
  // An editor's own token still cannot merge: agents only propose.
  const created = await apiCall<{ secret: string }>(eddie, "POST", "/tokens", {
    name: "Script",
    expiresInDays: 1,
  });
  const merge = await fetch(`${APP}/api/v1/change-sets/${number}/merge`, {
    method: "POST",
    headers: { authorization: `Bearer ${created.secret}` },
  });
  expect(merge.status).toBe(403);
});
