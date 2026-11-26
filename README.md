# Handbook

ProjectTogether's open-source knowledge base: spaces of Markdown pages that
staff edit in the browser and AI agents read and change through MCP, with
every agent change reviewed by a person before it goes live.

- **Spaces of Markdown pages.** One space per team or topic, pages in a
  tree, each page one Markdown file with YAML frontmatter. No HTML, no
  proprietary blocks: export a space as a folder of `.md` files any time.
- **Properties, page types and tags.** Built-in properties (title,
  description, status, tags, owner, review date, search terms) plus custom
  properties per space with types, page types with templates and required
  properties. Every save is checked against them. New spaces start from a
  template (Blank, Team, IT, People, Finance, Engineering, Product) with
  ready page types, properties and section pages.
- **Everyone reads, selected people edit.** Everyone who signs in reads every
  space. Owners and editors are set per space in the app.
- **Change sets: review like pull requests.** Changes collected in a change
  set stay invisible until an editor merges them, with diffs, checks,
  comments, "request changes", one-click merge and one-click revert. Staff
  without edit rights use them to suggest edits.
- **Agents with the same rules.** An MCP server for Claude, ChatGPT,
  Langdock, Claude Code, Codex and other clients, with OAuth sign-in or
  personal tokens. Agents read everything and write only into change sets;
  they never publish or merge.
- **Nobody overwrites anybody.** An edit lock keeps a second person out of a
  page while someone edits it; it expires, and editors can take it over.
  Every save checks the revision it started from and merges or asks.
  Unsaved text is kept as a draft.
- **Full history.** Every save, move, delete and restore is a revision with
  author, channel and change set; restore any version, revert any change set.
- **Search** in several languages with word forms, section anchors and typo
  tolerance, also as a read-only API for bots.
- **Sign-in** with any OpenID Connect provider (Keycloak, Microsoft Entra
  ID, Google, Authentik, …), optionally limited to email domains or groups.
- **Deploys at any time:** every change is one transaction, so a restart
  loses nothing; connected agents keep working.

Hono server, React web app, PostgreSQL, one Docker image, with error
reports and performance data for Sentry.

## Documentation

- [User guide](docs/user-guide.md): spaces, pages, properties, editing,
  suggestions and review.
- [Agents and MCP](docs/agents.md): connecting Claude, ChatGPT, Langdock and
  other agents; what they may do.
- [Deployment](docs/deployment.md): running it on a Linux server (Debian,
  Ubuntu), service tokens from the command line, upgrades, builds and
  deploys, backups, Sentry.
- [Configuration](docs/configuration.md): every environment variable.
- [Identity and access](docs/identity-and-access.md): sign-in, admins,
  owners, editors, access limits.
- [Architecture](docs/architecture.md): how it works inside.
- [Contributing](CONTRIBUTING.md): development setup and checks.

## Quick start (development)

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 and a Keycloak with test users
cp .env.example .env.local
npm ci
npm run dev
```

Open http://localhost:5173 and sign in as `ada@example.org` (password
`handbook-dev`), an admin. Create a space under **Administration →
Spaces**.

## License

Copyright 2026 ProjectTogether gGmbH

Licensed under the [Apache License 2.0](LICENSE).
