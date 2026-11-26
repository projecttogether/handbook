# User guide

How to read, write and review pages.

## Spaces and pages

A **space** is one knowledge base, usually of a team or a topic. The sidebar
lists them. Everyone signed in reads every space; its **owners** and
**editors** change it (listed in the space's settings).

A **page** is one Markdown file with properties. Pages form a tree: a page
can have sub-pages, and its address follows the tree:
`/s/<space>/onboarding/laptop`. Old addresses keep working after a page
moves.

## Reading

- **Search** at the top of the sidebar (Ctrl+K or ⌘K, or `/`) finds words
  in titles, search terms, tags and text, also in other word forms (e.g.
  "laptops" finds "laptop") and with small typos in titles. Results jump to
  the matching section. **Show all results** opens the search page, which
  can narrow the results to one space.
- **Tags** group pages across spaces.
- A page reads like an article: its type, title and description, who owns
  it and when it was last reviewed, then the text. On wide screens its
  sections are listed beside the text. After the text come its tags, its
  other properties, the pages below it, and the pages that link to it
  ("Linked from").
- The bar above the text has **Edit** or **Suggest an edit**, **History**
  (every version, who changed it and how), **Copy link**, **View Markdown
  file** and a menu with more.
- On pages the sidebar starts hidden, so the text has room; the button in
  the top bar (or Ctrl+B or ⌘B) shows it and hides it again. The app
  remembers your choice, for pages and for the rest of the app.
- **Keys:** G then O opens the overview, G then C the change sets, G then T
  the tags. Ctrl+/ lists every shortcut. Shortcuts with single letters can
  be turned off under **Settings**.

## Writing

Editors use **Edit** on a page, or **New page** in a space. The editor fills
the window and looks like the page: you edit the title, the description and
the text where they appear.

- **Rich text** is the default. Select text for a toolbar (bold, italic,
  strikethrough, code, link, headings, quote). Type `/` at the start of a
  line, or click **+** beside an empty line, to insert headings, lists, task
  lists, quotes, callouts, tables, code blocks, dividers, images and files,
  or links to pages. Markdown shortcuts work too: `## ` starts a heading,
  `- ` a list, `**bold**` makes bold text, and `> ` then `[!TIP] ` a
  callout. Ctrl+K adds a link: paste an address or type to find a page.
- **Markdown** in the top bar shows the whole file, frontmatter and text, as
  Markdown. Switch back and forth at any time; the editor remembers your
  choice. Parts that rich text cannot show (HTML, footnotes, reference
  links) appear in rich text as a **Markdown** box you edit as text.
- **Page settings** (the sliders button) holds the other properties: page
  type, status, tags, owner, last reviewed, search terms and the space's own
  properties.
- **Save** asks for an optional note about the change, shown in the
  history; Ctrl+S saves at once. Everything you did not change stays
  exactly as it was written, in rich text too: editing one paragraph never
  rewrites the rest of the file, so history, diffs and agents see only your
  change.
- **New pages:** choose where the page goes (above the title), give it a
  title (its address follows the title; **Change** edits it), and pick a page
  type to start from.
- Markdown with GitHub's additions: headings, lists, task lists, tables,
  links, code, and callouts:

  ```markdown
  > [!WARNING]
  > Back up the laptop before you send it in.
  ```

  The callout kinds are `NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`.
  HTML is shown as text, never run.

- **Limits:** a page has at most 500,000 characters. Saving refuses Markdown
  that would take too long to show, and names the line: lists, quotes and
  footnotes nested more than 16 levels deep, a paragraph (lines without a
  blank line between them) of more than 20,000 characters or with more than
  1,000 `*`, `_` and `~`, and very long pages full of lists, quotes or
  tables. Split those up with blank lines or into several pages.

- **Links to other pages** are ordinary Markdown links: `[VPN](vpn)` links
  to a page next to this one, `[AI policy](../policies/ai)` one level up,
  `[Leave](/s/hr/leave)` to another space. In rich text, the link button
  (Ctrl+K) and **Link to a page** in the `/` menu find pages for you.
- **Images and files:** paste or drop them into the text, or choose **Image
  or file** in the `/` menu.
- **Page types** start a new page from a template and can require
  properties. Every space starts with four: **Overview** (what something is,
  or the start page of a section), **How-to** (the steps of one task),
  **Policy** (rules people must follow; needs an owner and the date it was
  last reviewed) and **Reference** (facts to look up). Owners can change
  them and add more.
- **Status:** `draft` pages, and every page below a draft, are only
  visible to the space's editors until the draft is published (set to
  `active`); `deprecated` pages show a notice, with "Replaced by" pointing
  to the newer page.

### When someone else edits the same page

Only one person edits a page at a time. When someone else has the page open
in the editor, you see who and since when, and can read the page, suggest
your change instead, or (editors) **Take over**. The other person then sees
that you took over; their text stays saved as a draft.

After a pause (30 minutes without typing, or a computer that went to sleep)
others may open the page in the editor. The editor says so; when you type
again it continues, unless someone else started editing meanwhile.

The editor saves your unsaved text as a draft every few seconds and offers
it when you come back (also after the page was deleted and restored). If
the page changed while you edited it (for example after a takeover or a
merged change set), saving combines both changes, also two changes to
different words of one paragraph; if both changed the same words, the
editor switches to Markdown and shows both versions of those lines marked:

```
<<<<<<< yours
your lines
=======
the current lines
>>>>>>> current
```

Keep what is right, remove the marks, and save again.

## Suggesting changes: change sets

A **change set** collects changes to pages of one space: new pages, edits,
moves and deletions. Nobody sees them on the pages until an editor merges
them. Readers use **Suggest an edit** on a page (or **Suggest a new page**
in a space); editors can use change sets for larger work too; AI agents
always use them.

1. **Suggest an edit** opens the editor. Saving asks for a title and why,
   and **Send for review** asks the space's editors to look at it: they
   find it on their start page under "Waiting for your review". The change
   set opens; add more pages with **Add a page** or **Edit** on its pages.
2. A change set that is open but not in review (one an agent or an editor
   started, or one an editor asked to change) goes to the editors with
   **Submit for review**.
3. Editors see each page's changes as a diff, with the changed words marked
   (or a preview), the
   **checks** (errors block merging, e.g. a missing parent page; warnings,
   e.g. a link to a page that would not exist), and the activity. They
   comment, **Request changes**, or **Merge**.
4. **Merge** publishes every page of the change set at once. If a page
   changed live in the meantime, both changes are combined; if they overlap,
   **Update from live** on that page brings the current version in with the
   overlapping lines marked, to resolve before merging.
5. **Revert** on a merged change set undoes all its pages at once, as a new
   change set that is merged right away (or left open when later changes
   overlap; **Revert** again then opens that one).

**Close** shelves a change set; **Reopen** brings it back. Nothing is ever
lost: every version stays in the history, deleted pages go to the space's
trash, closed change sets stay readable.

## Agents

Under **Settings → Connect an agent** you find the address for AI agents
(Claude, ChatGPT, Langdock, Claude Code and others). An agent acts as you:
it reads everything and proposes changes as change sets for editors to
review; it never publishes or merges. See [Agents and MCP](agents.md).

## Owners: setting up a space

Admins create spaces under **Administration → Spaces** and pick a
**template**: what the space starts with. Every template has the four
default page types; the others add their own page types, properties and
top-level pages for the main sections:

| Template    | Adds page types          | Adds properties                           | Starts with pages                                                            |
| ----------- | ------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------- |
| Blank       |                          |                                           |                                                                              |
| Team        | Decision                 |                                           | How we work, Decisions, Joining the team                                     |
| IT          | Tool, Troubleshooting    | Systems, Audience                         | Software, How-to guides, Onboarding and offboarding, Help, Policies, IT team |
| People      | Benefit                  | Applies to, In effect since               | Joining and leaving, Time off, Pay and benefits, Working here, Policies      |
| Finance     |                          | Applies to, In effect since, Form or tool | Expenses and travel, Purchases and invoices, Budgets, Policies               |
| Engineering | Runbook, Decision        | Systems, Repository                       | Architecture, Development, Runbooks, Decisions                               |
| Product     | Spec, Research, Decision | Stage                                     | Strategy, Specs, Research, Decisions                                         |

The same key means the same thing in every space: `type: policy` or a
`systems` property, for example. Everything a template brings belongs to
the space afterwards; owners change it like anything else.

In the space's **Settings**:

- **Owners and editors**: add people by email (also before their first
  sign-in). Only admins add owners.
- **Properties**: custom fields of the space's pages, with a type (text,
  list, number, yes/no, date, one choice, several choices, URL, person),
  optionally required. Pages may only use defined properties; a change that
  would make existing pages invalid is refused with the pages named.
- **Page types**: a label, a key, what pages of the type are for, a
  template for new pages and required properties: the space's own or the
  built-in description, tags, owner, last reviewed and search terms.
- **Add from a template**: adds a template's page types and properties that
  the space doesn't have yet, e.g. the default page types to a space created
  before they existed. What the space has stays as it is; pages come only
  with new spaces.

The space menu also has **Export**: a zip of the space's Markdown files
(sub-pages in folders) and the images and attachments they use, in
`files/<id>/<name>` where the pages' links (`/files/<id>/<name>`) find
them.

To bring existing content in, let an agent write it: it reads your
documents and creates the pages in a change set, which an editor reviews
and merges ([Agents and MCP](agents.md)).

Built-in properties every page may have: `title` (required), `description`,
`type`, `status`, `tags`, `owner` (an email address), `reviewed` (a date),
`replaced_by` (a page path) and `search_terms` (other words people search
for, e.g. in another language).

## Admins: the version

**Settings and agents → About** shows admins the version that runs: the
commit the app was built from, linked to its source code. Every change on
`main` is deployed on its own ([Deployment](deployment.md#builds-and-deploys)).
