# AGENTS.md

Handbook is ProjectTogether's open-source knowledge base: spaces of Markdown pages
with YAML frontmatter, edited by staff in the browser and by AI agents
through MCP. Agents and readers propose changes as change sets that editors
review and merge. User documentation is in `docs/`; contributor setup is in
`CONTRIBUTING.md`; how it works inside is in `docs/architecture.md`.

## Stack

npm workspaces, Node.js 26, strict TypeScript.

- `apps/server`: Hono (API under `/api/v1`, MCP under `/mcp`, OAuth under
  `/.well-known` and `/oauth`), Better Auth (OIDC sign-in under `/api/auth`),
  Drizzle ORM on PostgreSQL, remark (Markdown analysis), the MCP TypeScript
  SDK, pino logs, Sentry, Vitest.
- `apps/web`: Vite + React 19, TanStack Router and Query, Tailwind CSS 4,
  Tiptap (the rich-text editor; `components/editor/rich-text/` keeps
  unchanged Markdown as written), CodeMirror 6 (the Markdown view),
  react-markdown. `src/components/ui/` holds the components (shadcn/ui and
  Radix), the app frame, the page layout, the sign-in page and the theme
  with ProjectTogether's colors (`styles.css`); `src/components/brand.tsx`
  the app icon and ProjectTogether's logo. US English.
- `packages/shared` (`@handbook/shared/*`): zod schemas of the API
  (`api/*.ts`), the page file model (`page.ts`), paths and links
  (`paths.ts`), merging and edits (`merge.ts`), roles and abilities
  (`roles.ts`), limits.

One Docker image runs every process: `APP_ROLE` = `all | web | worker | migrate`;
its command `cli …` runs the operator command (`cli tokens`).

## Layout

```
apps/server/src/
  main.ts          entry; APP_ROLE selects the processes
  cli.ts           entry of the operator command; its commands are in cli/
  config.ts        every environment variable (zod); read only via config()
  db/schema/       Drizzle schema (auth.ts, app.ts)
  auth/            Better Auth, sign-in access check, credentials (tokens), principals
  pages/           the page core (core.ts: the one write path), locks, views, Markdown analysis
  changes/         change sets: items, checks, merge, revert
  spaces/          spaces, members, abilities (access.ts), what each principal sees (visibility.ts)
  search/          search queries and the index
  exports/         export of spaces (zip of pages and their uploads)
  files/           uploaded files on disk
  oauth/           OAuth 2.1 server for connected apps (MCP clients)
  mcp/             MCP server and tools (call the REST API in-process)
  http/            app factory, middleware, errors, raw routes (/files, /s/*.md, /llms.txt)
  modules/         one file per API area: routes
  worker/          scheduled jobs
apps/web/src/      web app; modules/<area> holds each area's pages
packages/shared/src/  contracts, page model, paths, merge, roles
```

## Rules

- **Contracts first.** Change a request or response in
  `packages/shared/src/api/` and use it on both sides; routes validate input
  with it (`jsonBody`, `queryOf`).
- **Access:** every route starts with `requirePrincipal`, `requireUser`,
  `requireWebUser` or `requireAdmin`, and space actions check
  `spaceContext` + `requireAbility`. Abilities come only from
  `spaceAbilities` in `packages/shared/src/roles.ts`. Agents (personal
  tokens, connected apps) never edit live, never merge and never administer;
  service tokens only read. Only `cli/` creates the `operator` principal, with
  an admin's rights; it calls the same service functions as the admin routes.
- **Drafts and the trash:** a draft hides itself and every page below it
  from those without `seeDrafts`. Every list, count and read of pages or
  change sets filters through `apps/server/src/spaces/visibility.ts`
  (`visibilityOf` across spaces, `spaceVisibility` in one); never test
  `seeDrafts`, a page's status or its ancestors for access elsewhere.
- **Pages change only through `apps/server/src/pages/core.ts`** inside a
  transaction (`lockPage` first). It validates the file, merges with changes
  saved meanwhile, stores the revision and rebuilds sections, links and
  search data. Never update `pages` or `page_revisions` elsewhere.
- **Page files:** parse and write them only with
  `packages/shared/src/page.ts`; links resolve only with `resolveLink`.
- **Credentials** are stored as SHA-256 hashes; secrets are shown once and
  never logged. Never log authorization codes, PKCE verifiers or tokens.
- **Contracts others rely on:** other apps read Handbook with service
  tokens (search and pages API), and AI clients connect to `/mcp` with
  OAuth (dynamic client registration, refresh tokens) or personal tokens.
  Keep token formats and prefixes, their hashing, the OAuth routes and
  client records, `/mcp` and the API paths as they are.
- **Restarts:** a deploy may restart `web` and `worker` at any time. Keep
  every change one transaction, and the worker's jobs safe to repeat.
- **Environment variables:** document each in `docs/configuration.md`. An
  app setting (not one of the server settings in `docs/deployment.md`,
  Settings) also needs a line in the Deploy workflow's `SETTINGS`.
- **Design:** ProjectTogether's colors and app identity (PT Sky for buttons,
  focus and selected states, with PT Ocean text on it; links in the darker
  `--link`); the tokens are in `apps/web/src/components/ui/styles.css`.
  Keep components close to shadcn/ui (`@/components/ui/<name>`, `cn` from
  `@/components/ui/utils`).
- **Errors:** throw `AppError` helpers (`http/errors.ts`) with short, plain
  messages.
- **Logging:** `logger` with ids and codes; never page texts, titles, email
  addresses, tokens or other personal data. No `console.*`, no `any`.
- **Sentry** gets no personal data: `redactErrorReport` and `redactLog`
  decide what reports and logs keep; no session replays.
- **SQL in select lists:** Drizzle writes column names there without the
  table name; inside a correlated subquery write `"table"."column"`
  yourself.

## Database

Change the schema in `apps/server/src/db/schema/`, then run
`npm run db:generate` and commit the migration. CI fails when they differ.
The running installation's database must keep working: add only migrations
that the previous version survives (new columns with a default), and only
when needed. Stored values (token kinds and prefixes, statuses, setting
keys) stay as they are.

## Tests

- Unit tests next to the code (`*.test.ts`); integration tests
  (`*.int.test.ts`) use the PostgreSQL of `compose.dev.yaml` and
  `src/test/helpers.ts` (`resetDatabase`, `createUser`, `createSpace`,
  `createPage`, `createToken`, `request`).
- API tests act as web users with
  `vi.mock("../auth/resolve", () => import("../test/resolve-mock"))` and the
  `userId` option; bearer tokens (`token` option) work as in production.
- End-to-end tests (`e2e/`) run a real browser against the built app and the
  development Keycloak.

## Commands

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL (55450), Keycloak (8104)
cp .env.example .env.local
npm ci
npm run dev                                # web app http://localhost:5173, server :3000

node scripts/check-public-repository.mjs
npm run lint && npm run format:check && npm run typecheck && npm test
npm run test:integration
npm run build && npm run test:e2e
```

Deploys: every commit on `main` that passes CI is built and deployed
(`docs/deployment.md`, Builds and deploys). No file holds the version.

## Content

UI text and messages are in US English; short and plain. Never commit
secrets, real personal data or data from a real organization: use
`example.org` addresses and invented content. Keep ProjectTogether's
internals (server names, addresses, internal domains, people, vault names)
out of this repository; they belong in its infrastructure repository.
