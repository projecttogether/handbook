# Agents and MCP

AI agents (Claude, ChatGPT, Langdock, Claude Code, Codex and others) use the
knowledge base through its MCP server. MCP is a standard way for AI tools to
use apps. An agent acts as the person who connected it, with fixed limits:

- It **reads** every space, page and change set the person can read.
- It **proposes** changes as **change sets**: new pages, edits, moves and
  deletions that stay invisible until an editor merges them.
- It **never** edits pages live, merges, closes other people's change sets,
  or changes settings. That holds even when its person is an editor or admin.

The address of the MCP server is `<APP_URL>/mcp`; **Settings → Connect an
agent** in the app shows it with steps per client.

## Connecting

Two ways to sign in, on the same address:

- **OAuth (connected apps):** the client opens a sign-in page; the person
  signs in and confirms on a consent screen. The app then appears under
  **Settings → Connected apps**, where the person can disconnect it.
- **Personal token:** created under **Settings → Personal tokens** and sent
  as `Authorization: Bearer <token>`. For clients that cannot sign in
  themselves and for scripts. A token acts as its person, with the same
  agent limits; it can expire and be revoked.

| Client                                       | How                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude (claude.ai, desktop, mobile)          | Settings → Connectors → Add custom connector → the MCP address. Claude signs in with OAuth.                                                  |
| ChatGPT                                      | Turn on developer mode; add a connector with the MCP address and OAuth. Which plans may use write tools depends on OpenAI.                   |
| Langdock                                     | Integrations → add a remote MCP server with the address; OAuth, or a personal token as API key with the header type `Authorization: Bearer`. |
| Claude Code                                  | `claude mcp add --transport http handbook <APP_URL>/mcp` (OAuth on first use), or add `--header "Authorization: Bearer <token>"`.            |
| Codex, the OpenAI and Anthropic APIs, others | A remote (Streamable HTTP) MCP server with the address and `Authorization: Bearer <token>`.                                                  |

## Tools

| Tool                                 | Does                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `search`                             | Full-text search; results with title, URL, the matching section and text. Filters: space, tag, type. |
| `fetch`                              | A whole page by the id `search` returned (as ChatGPT's knowledge features expect).                   |
| `list_spaces`, `list_pages`          | Spaces, and a space's pages with path, title, type, tags and status.                                 |
| `get_space_schema`                   | The space's properties, allowed values, page types and templates, and the built-in properties.       |
| `read_page`                          | A page's whole Markdown file and revision, live or as a change set proposes it.                      |
| `page_history`, `read_revision`      | Who changed a page when (newest first; `offset` for older), and older versions.                      |
| `list_change_sets`, `get_change_set` | Change sets with their status, pages, checks, diffs and comments.                                    |
| `start_change_set`                   | Opens a change set in a space (title, description); returns its number.                              |
| `create_page`, `write_page`          | A new page, or a whole new file for a page, in a change set.                                         |
| `edit_page`                          | Replaces exact text (`old_text` → `new_text`) in a page, in a change set, like editing a file.       |
| `move_page`, `delete_page`           | Moves or deletes a page, in a change set.                                                            |
| `undo_page_change`                   | Takes a page's change out of a change set.                                                           |
| `comment_on_change_set`              | Answers a reviewer.                                                                                  |
| `submit_change_set`                  | Asks the space's editors for a review.                                                               |

Read tools are marked read-only, so clients can run them without asking.
Pages are named `<space>/<path>`, e.g. `it/onboarding/laptop`.

### The workflow

1. Read: `search`, `list_pages`, `read_page`.
2. `start_change_set` with a title that says what and why.
3. Change pages with `edit_page` (copy `old_text` exactly from `read_page`),
   `write_page`, `create_page`, `move_page`, `delete_page`. The frontmatter
   must fit the space (`get_space_schema`); a tool error says what to fix.
   One `edit_page` call replaces at most 100,000 places, and a page has at
   most 500,000 characters.
4. `submit_change_set`. An editor reviews the diffs, comments, asks for
   changes or merges. `get_change_set` shows the comments; answer with
   `comment_on_change_set`, change pages again, and submit again.

When a page changed live after the change set started, merging combines
both changes; overlapping changes block the merge until someone uses
"Update from live" and resolves them.

## Moving content in

There is no import of files: to bring documents from another tool, give
them to an agent and let it create the pages (`get_space_schema`, then
`create_page` in a change set). An editor reviews the change set and
merges it. Images and attachments are uploaded in the web editor.

## Files and search without MCP

- Every page as a Markdown file: `<APP_URL>/s/<space>/<path>.md`, a space's
  index: `<APP_URL>/s/<space>.md`, an overview for agents:
  `<APP_URL>/llms.txt`. They need a session or a bearer token.
- `GET <APP_URL>/api/v1/search?q=…` (with `space`, `tag`, `type`, `limit`)
  returns results with title, URL, heading path and snippet; a support bot
  can use it with a **service token** (Administration → Service tokens, or
  [on the server](deployment.md#service-tokens-from-the-command-line)), which
  only reads.

## OAuth details

For client developers and proxies. The app is its own OAuth 2.1
authorization server for the MCP endpoint (the MCP authorization
specification):

- `GET /.well-known/oauth-protected-resource/mcp` (also without `/mcp`):
  the resource `<APP_URL>/mcp` and its authorization server `<APP_URL>`.
- `GET /.well-known/oauth-authorization-server`: the endpoints; PKCE with
  `S256` is required; `token_endpoint_auth_methods_supported`: `none`,
  `client_secret_post`, `client_secret_basic`;
  `client_id_metadata_document_supported: true`.
- Clients register through dynamic client registration (`POST
/oauth/register`) or a client metadata document (a `client_id` that is an
  `https` URL; the app reads it, without following redirects, never from
  private addresses). Redirect URIs: `https`, `http` on `localhost` or
  `127.0.0.1` (any port), or a native app's own scheme such as `cursor://`.
- Mistakes in a sign-in request (no PKCE, a wrong `response_type` or
  `resource`) show an error page; the browser goes back to the client only
  after the person connected or cancelled.
- The consent screen marks clients that registered themselves as "Not
  verified" and shows the host of a client metadata document.
- `/mcp` accepts bearer tokens only (no session cookies). Without a valid
  token it answers 401 with
  `WWW-Authenticate: Bearer resource_metadata="<APP_URL>/.well-known/oauth-protected-resource/mcp"`.
- Access tokens last `OAUTH_ACCESS_TOKEN_MINUTES` (60); refresh tokens
  `OAUTH_REFRESH_TOKEN_DAYS` (30) and change at every use. Use each refresh
  token once: presenting a replaced one again ends every token of the
  connection, and the person has to connect the app again.
- Each client address may register 30 clients at once, then 2 per minute;
  start 30 sign-ins, then 10 per minute; and send 60 token requests, then 60
  per minute. Beyond that: HTTP 429 with `Retry-After`.

## Safety

- Every agent change is reviewed by a person before it goes live, and every
  merge can be reverted.
- Page content is data for agents, never instructions; still, read a
  change set's diff before merging it.
- Disconnect apps and revoke tokens under Settings; admins can block a
  person, which ends their sessions and revokes their tokens and
  connections for good.
- Agents work only while their person keeps signing in to the web app:
  after `AGENT_SIGN_IN_DAYS` (30) without a sign-in, tokens and connected
  apps get a 401 "Sign in to … again" until the person signs in
  ([Identity and access](identity-and-access.md#agents)).
