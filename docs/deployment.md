# Deployment

For the person who runs Handbook on a Linux server, such as a VPS with
Debian or Ubuntu: requirements, [setup](#setup),
[service tokens from the command line](#service-tokens-from-the-command-line),
[upgrades](#upgrades), [builds and deploys](#builds-and-deploys), backups,
Sentry and logs. Every environment variable is described in
[Configuration](configuration.md).

## Requirements

- **A server with Debian 12 or later** (or a similar system with systemd and
  apt, such as Ubuntu 24.04), with Docker Engine and its Compose plugin, and a
  domain name that points at it.
- **PostgreSQL 16 or later**, with the `pg_trgm` extension available (it is
  part of the standard PostgreSQL packages and images; the first migration
  creates it): a database of your own, or the one `compose.postgres.yaml`
  adds.
- **Caddy** (or another reverse proxy on the server) that terminates HTTPS.
- **An OpenID Connect provider** for sign-in (Keycloak, Microsoft Entra ID,
  Google, Authentik, …), see [Identity and access](identity-and-access.md).
- **Disk space for uploaded files** (a volume).

## What runs

The [Deploy workflow](#builds-and-deploys) builds the image
`ghcr.io/projecttogether/handbook` (linux/amd64) from every commit on `main`
that passes CI, tagged `sha-<commit>` and `latest`. There are no numbered
releases: the commit is the version. `HANDBOOK_IMAGE_TAG` in `.env` picks
the image: `latest` (the default) or `sha-<commit>` for one build.

| File                    | Contains                                                                          |
| ----------------------- | --------------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command (`all`, `web`, `worker`, `migrate`, `cli`) picks the role. |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`) and the `worker`.                        |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.      |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`HANDBOOK_PORT` changes the host port. With several apps on one server, give
each its own port and its own site in the Caddyfile. Uploaded files are
stored in the volume `files` (`/data/files` in the container), shared by
`web` and `worker`; the database of `compose.postgres.yaml` is in the volume
`postgres`.

The reverse proxy must pass `/mcp`, `/oauth/*` and `/.well-known/*` to the
app unchanged (agents connect there), and must not buffer or cache them:
`/mcp` streams its answers as events (nginx: `proxy_buffering off;` for
`/mcp`). The app compresses its responses itself (scripts and styles with
brotli or gzip; JSON, HTML and Markdown with gzip; never `/mcp` or
`/files`), so the proxy needs no compression of its own. A proxy that
compresses anyway must leave `/mcp` alone.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process. Mount a volume at `/data/files`.

## Setup

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files:**

   ```sh
   git clone https://github.com/projecttogether/handbook.git /srv/handbook
   cd /srv/handbook
   ```

3. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set production values: `APP_URL`, `DATABASE_URL`,
   a new `AUTH_SECRET` (`openssl rand -base64 32`), the `OIDC_*` values,
   your address in `ADMIN_EMAILS`, and
   `SEARCH_LANGUAGES` for the languages your pages are written in. Remove
   `NODE_ENV=development`, `RUN_MIGRATIONS` and
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. With an `https` `APP_URL`, the app
   does not start with the example `AUTH_SECRET` or with
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. Without a database of your own, add
   `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a `POSTGRES_PASSWORD`
   (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://handbook:<POSTGRES_PASSWORD>@postgres:5432/handbook`.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   handbook.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself, and it
   passes the event streams of `/mcp` through without buffering. With
   `HANDBOOK_PORT` set, use that port instead of 3000.

7. Open `APP_URL`, sign in, and create the first space under
   **Administration → Spaces**.

## Service tokens from the command line

Admins create read-only [service tokens](identity-and-access.md#agents)
under **Administration → Service tokens**. An operator, or AI with access to
the server, can do the same without a browser:

```sh
docker compose run --rm -T migrate cli tokens list
```

In a running container, `cli` is on the `PATH`:
`docker compose exec web cli tokens list`. `cli help` lists every command.
It runs the same code as the page, with an admin's rights. The audit log
names the actor `operator` and the command; the page shows **Operator** under
**Created by**.

| Command                                   | What it does                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cli tokens create service --name <name>` | A new token. It expires after 90 days; `--expires-in-days <days>` sets 1 to 3650 days, `--expires-in-days never` no end. |
| `cli tokens list [--json]`                | The tokens that are not revoked: ID, name, first characters, created, last used, expiry. Never the token itself.         |
| `cli tokens revoke <id>`                  | Ends a token for good.                                                                                                   |

A new token is printed once, alone on stdout; its ID and expiry go to
stderr. So `> file` keeps only the token, here in a new file that only the
current user may read (`set -C` refuses to overwrite one that is there
already):

```sh
(umask 077; set -C; docker compose exec -T web \
  cli tokens create service --name Connector > connector.token)
```

Create tokens with `exec` as here, not with `run`: what a container started
with `run` prints also goes to Docker's logging driver, which may keep it.

AI with access to the server writes the token into a file like this, passes
it on to the app that uses it (for example in the body of that app's
`cli settings apply`), checks the connection there and deletes the file.

Exit codes: 0 done; 1 the app refuses, with the page's message on stderr;
2 a wrong command. Handbook's settings are in `.env`
([Configuration](configuration.md)), so there is no `cli settings`.

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age. It stops while a job runs far longer than
  it should (the hourly cleanup 30 minutes, rebuilding the search index 4
  hours), so the check fails.
- Database connections give up after 10 seconds of waiting for a
  connection, end statements after `DATABASE_STATEMENT_TIMEOUT_SECONDS`
  and transactions left idle for a minute, and probe idle connections for
  lost ones.

Docker Compose marks a container whose check fails as unhealthy, but does
not restart it. Set up an uptime check from outside the server (your
monitoring or an uptime service) on `<APP_URL>/-/readyz`, so that someone
hears when the app is down.

## Upgrades

An upgrade pulls a newer image. In `/srv/handbook`:

1. Read the pull requests merged since the running commit (admins see it
   in **Settings and agents** under **About**). A pull request labeled
   `breaking` says what to do; take those steps.
2. Run `git pull` for the newest `compose.yaml`, then
   `docker compose up -d --pull always`. With `HANDBOOK_IMAGE_TAG` pinned to
   `sha-<commit>`, set the new commit first.

The `migrate` service applies database migrations before `web` and `worker`
start.

### Restarts

An upgrade or a deploy may restart `web` and `worker` at any time:

- **Saves, merges and reverts** are one transaction each; a request cut
  short by the restart saves nothing, and the editor still shows the text,
  which the next save sends again. Agents connected through MCP need no new
  sign-in: `/mcp` keeps no session between requests.
- **The worker's jobs** start again with the next worker: rebuilding the
  search index (one short transaction per page) and the cleanup are safe to
  repeat.

## Builds and deploys

Every commit on `main` that passes CI is built and, at ProjectTogether,
deployed. There are no numbered releases: the commit is the version.

- **CI** (`.github/workflows/ci.yaml`, on every pull request and on `main`):
  the history for secrets (Gitleaks), the files for private artifacts,
  internal names and credential formats (`scripts/check-public-repository.mjs`),
  lint, formatting, types, unit tests, migration drift, the build, the audit
  of the production dependencies, the integration tests (PostgreSQL), the
  browser tests (Keycloak), and the image (started with `compose.yaml`).
- **Deploy** (`.github/workflows/deploy.yml`), when CI passes on `main`, or
  by hand (Actions → Deploy → Run workflow), for example after a setting
  changed:
  1. It builds `ghcr.io/projecttogether/handbook` with `APP_VERSION` set to
     the first 12 characters of the commit and pushes it as `sha-<commit>`
     and `latest`.
  2. It sends the image and the app's settings to the server of the GitHub
     environment `production` over SSH. The server's deploy script pulls the
     image, writes the settings, runs the migrations, starts `web` and
     `worker`, waits until both are healthy, and puts the previous image and
     settings back when they do not become healthy. One deploy runs at a
     time; a newer one waits.

Without the variable `DEPLOY_HOST` in the environment `production`, step 2
deploys nothing. Label a pull request `breaking` when the people who run the
app must act on it, and write the steps into its description; merging
deploys it, so take steps that must come first before merging.

The package `handbook` in GitHub's container registry must be public, so
that servers can pull it without a token: an owner of the organization sets
that once, after the first build.

### Settings

The settings come from two places:

- **Server settings**, written on the server by its own configuration
  (ProjectTogether's infrastructure repository): `APP_URL`, `DATABASE_URL`,
  `TZ`, `TRUST_PROXY`, `AUTH_SECRET`, and `POSTGRES_PASSWORD` with
  `compose.postgres.yaml`. They win over the app settings.
- **App settings**, sent by the Deploy workflow at each deploy from the
  environment `production`, as the workflow's `SETTINGS` list names them.
  Empty values are left out, so the app's default applies. A new setting
  needs a line in `SETTINGS` and its own line below it.

| Kind      | Names                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets   | `DEPLOY_SSH_KEY`, `OIDC_CLIENT_SECRET`, `ADMIN_EMAILS` (a secret, so that run logs of a public repository do not show the addresses), `SENTRY_DSN`                            |
| Variables | `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `APP_URL` (the environment's link only), `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_PROVIDER_NAME`, `SEARCH_LANGUAGES`, `SENTRY_ENVIRONMENT` |

The build reads one more secret, of the repository or the organization, not
of the environment: `SENTRY_AUTH_TOKEN`
([Sentry](#error-reports-and-performance-data-sentry)). Elsewhere,
`compose.yaml` with a plain `.env` holds both kinds of settings
([Setup](#setup)).

### Rollbacks

A deploy that does not become healthy puts the previous image back by
itself. To go back by hand, revert the change on `main`, or run the server's
rollback. Neither undoes database migrations, so a migration keeps the
previous version working: add columns with a database default.

## Backups

Back up together:

- the PostgreSQL database (`pg_dump`, or the `postgres` volume): pages,
  every revision, change sets, people, tokens (as hashes);
- the `files` volume (uploaded images and attachments; pages refer to them).

Test a restore once, and again after larger changes to the setup: restore
the database and the `files` volume on another machine (or into a new
Compose project), start the app there, and open a few pages with images.

Each space can also be exported as a zip of its Markdown files and the
uploads its pages use (space menu → Export), for a copy outside the app.
It is not a backup of the app: history, change sets and people are not in it.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `handbook@<commit>` for
the images of the Deploy workflow, unless `SENTRY_RELEASE` is set, so
reports link to the code. The Deploy workflow uploads the source maps to the
Sentry project `projecttogether/handbook` when the secret
`SENTRY_AUTH_TOKEN` (an organization token) is set; without it, nothing is
uploaded. The web app's source maps are not in the image, so browsers cannot
download them.

- **Errors:** crashes, failed requests and errors the server logs, from the
  server and from browsers.
- **Performance:** set `SENTRY_TRACES_SAMPLE_RATE` (e.g. `0.2`) to trace
  that share of requests and page loads.
- **Logs:** warnings and errors of the server.
- **Cron monitor:** the worker's cleanup job checks in as `handbook-prune`.

Reports never contain page texts, titles, names, email addresses, tokens,
request data or variables; error messages are left out because database
errors can quote values. There are no session replays.

## Logs

Every process logs JSON lines to standard output (`docker compose logs
web`). Logs carry identifiers (page, change set, request), never page texts
or email addresses. Sign-ins that were refused log the reason (`sign-in
refused: email domain not allowed`, `… not in ACCESS_GROUPS`, `… blocked`,
`… email address not verified by the provider`).

## Hardening

- Serve the app over HTTPS only.
- Use your organization's own identity provider, where people cannot choose
  their email address themselves. With a public provider (e.g. Google),
  set `ALLOWED_EMAIL_DOMAINS` or `ACCESS_GROUPS`; without either, the
  server logs a warning at start.
- Keep `OIDC_REQUIRE_EMAIL_VERIFIED` on unless your provider does not send
  `email_verified` ([Identity and access](identity-and-access.md#verified-email-addresses)).
- When someone leaves, block them in the app for immediate effect
  ([Identity and access](identity-and-access.md#when-someone-leaves)).
- Keep `ADMIN_EMAILS` to one or two people.
- Agents only propose changes; editors decide. Read a change set's diff
  before merging it, also when an agent made it: page content can contain
  instructions meant to mislead agents.
- Pages are Markdown without HTML; uploads other than PNG, JPEG, GIF and
  WebP are always downloaded, never shown in the browser.
