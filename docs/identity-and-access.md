# Identity and access

People sign in through one OpenID Connect provider. Everyone who may sign in
reads every space. Admins, space owners and space editors are set in the
app.

## Roles

| Who                            | May                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everyone signed in             | Read and export every space (drafts and the pages below them only in spaces they edit); search, suggest changes as change sets, comment and connect agents. |
| Space editor                   | Also: create, edit, move and delete pages live; review, merge, close and revert change sets; restore pages and versions.                                    |
| Space owner                    | Also: the space's name and description, its editors, properties and page types.                                                                             |
| Admin                          | Everything in every space; create and archive spaces; choose owners; people; service tokens; the audit log; the version that runs.                          |
| Agent (token or connected app) | Acts as its person, but only reads and proposes: it writes only into change sets and never merges or administers.                                           |
| Service token                  | Reads only (search, pages, Markdown files): for integrations such as a support bot.                                                                         |

Archived spaces are read-only for everyone: no page changes, change sets,
comments or status changes until an admin restores the space.

Owners and editors are chosen in the space's **Settings**; owners can add
editors, only admins add owners. A person can be named by email before
their first sign-in and gets the role then.

Admins come from `ADMIN_EMAILS` (always admins, also the way back in) or are
made admins by another admin under **Administration → People**. There,
admins can also block someone: blocked people cannot sign in, their sessions
end, and their personal tokens and connected apps are revoked for good
(unblocking does not bring them back). See [When someone leaves](#when-someone-leaves).

Admins can also remove a person (**Remove** under **Administration →
People**), for example when someone leaves and asks for their data to be
deleted. Their name and email are replaced, and their sign-ins, tokens,
connected apps, unsaved drafts, edit locks and space roles are deleted.
Their page versions, change sets and comments stay, shown as "Removed
person", and the audit log keeps their actions without their email. Page
texts that name them (e.g. an `owner` property) are not changed; edit those
pages. If they sign in again, they start as a new person without roles.
People in `ADMIN_EMAILS` cannot be removed (take them out of the list
first), and nobody removes themselves.

## Sign-in

Register a client at the provider (confidential, authorization code flow)
with this redirect URL:

```
<APP_URL>/api/auth/callback/oidc
```

and set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. The
provider must return the email address (scopes `openid email profile`) and
vouch for it (below). Use your organization's own provider, where people
cannot choose their address.

Examples of `OIDC_ISSUER`:

| Provider           | Issuer                                               |
| ------------------ | ---------------------------------------------------- |
| Keycloak           | `https://login.example.org/realms/<realm>`           |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Google             | `https://accounts.google.com`                        |
| Authentik          | `https://auth.example.org/application/o/<slug>/`     |

### Verified email addresses

People are known by their email address: admins in `ADMIN_EMAILS` and
editors named before their first sign-in exist before they sign in, and
people who left keep their entry. So a sign-in counts only when the
provider vouches for the address: its claim `email_verified` must be `true`
(in the ID token, or in the userinfo response when the ID token has no
email address). Otherwise the sign-in is refused (the log says `sign-in
refused: email address not verified by the provider`), and the provider's
account is not linked to the person with that address.

Keycloak and Google send the claim (in Keycloak, mark addresses as verified
or let people verify them); with other providers, check that the ID token
or userinfo response has it. Microsoft Entra ID does not send it:
set `OIDC_REQUIRE_EMAIL_VERIFIED=false`. Then the app trusts every address
the provider returns, and anyone who can set an address there
(self-registration, an email attribute people may edit, guest or brokered
accounts) can sign in as the person with that address, an admin from
`ADMIN_EMAILS` included. Turn the check off only where the provider sets the
addresses and people cannot change them. With Entra ID, register the app
for your tenant only (the issuer with your tenant ID, as above) and admit
only your own staff with `ACCESS_GROUPS`. The server logs a warning at start
while the check is off.

## Who may sign in

By default everyone the provider lets through may sign in and read; the
server logs a warning at start. Two optional limits, checked at every
sign-in:

- `ALLOWED_EMAIL_DOMAINS=example.org,example.net`: only these domains.
- `ACCESS_GROUPS=/staff`: only members of one of these groups. The groups
  come from the claim `OIDC_GROUPS_CLAIM` (default `groups`) of the ID
  token, or of the userinfo endpoint when the ID token has none. Keycloak
  group paths count their subgroups: `/staff` admits `/staff/it`.

People refused at sign-in see "This account has no access"; the log says
why. Admins in `ADMIN_EMAILS` are never refused.

### Keycloak

1. Create a client (`Client authentication` on, standard flow) with the
   redirect URL above and the web origin `APP_URL`.
2. For `ACCESS_GROUPS`: add a mapper "Group Membership" to the client's
   dedicated scope with claim name `groups`, "Full group path" on, and
   "Add to ID token" on. Then set `ACCESS_GROUPS` to group paths, e.g.
   `/staff`.

### Microsoft Entra ID

Register an app with the redirect URL above (platform Web) and a client
secret. For `ACCESS_GROUPS`, add the groups claim in **Token configuration**
(the claim then holds group object IDs; use those in `ACCESS_GROUPS`).

## Sessions

A session lasts `SESSION_DAYS` (7) from sign-in; using the app does not
extend it. Then the person signs in again (with the provider's own session,
often without typing anything), and every sign-in checks access again:
blocked, verified address, email domain and groups.

## Agents

Agents act as a person through a connected app (OAuth) or a personal token,
with the limits above. See [Agents and MCP](agents.md).

The provider is asked only at sign-in, so agents work only while their
person keeps signing in: when someone has not signed in for
`AGENT_SIGN_IN_DAYS` (30), their personal tokens and connected apps stop
working. Agents then get a 401 with "Sign in to … again"; signing in to the
web app brings them back. `AGENT_SIGN_IN_DAYS=0` turns this off.

Service tokens belong to the installation, not to a person: they keep
working when the admin who created them leaves or is blocked.
**Administration → Service tokens** shows who created each one. They can
also be created on the server
([Service tokens from the command line](deployment.md#service-tokens-from-the-command-line));
the audit log then names the actor `operator`.

## When someone leaves

- **Block them** under **Administration → People** for immediate effect:
  their sessions end, sign-in is refused, and their personal tokens and
  connected apps are revoked for good.
- **Otherwise**, once the provider no longer lets them in (account disabled,
  removed from `ACCESS_GROUPS`), they cannot sign in again: their open
  sessions end within `SESSION_DAYS` of their last sign-in, and their agents
  stop within `AGENT_SIGN_IN_DAYS` of it.
- **Admins:** revoke and replace the service tokens they created; they saw
  the secrets.
