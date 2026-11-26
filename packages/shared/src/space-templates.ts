import { z } from "zod";
import {
  serializePageFile,
  type PageTypeDefinition,
  type PropertyDefinition,
  type PropertyType,
  type SpaceSchema,
} from "./page";

/**
 * Space templates: what a new space starts with. Every template has the
 * default page types (overview, how-to, policy, reference); most add page
 * types, properties and a few top-level pages of their own. A template is
 * copied into the space when it is created, and owners change the copy
 * like anything else in the space's settings. Owners of an existing space
 * can add a template's page types and properties later (`addTemplateSchema`).
 *
 * The same key means the same thing in every template, so `type: policy`
 * or a `systems` property mean one thing across spaces.
 */

function property(
  key: string,
  label: string,
  type: PropertyType,
  help: string,
  options: string[] = [],
): PropertyDefinition {
  return { key, label, type, options, required: false, help };
}

function pageType(
  key: string,
  label: string,
  help: string,
  template: string,
  requiredProperties: string[] = [],
): PageTypeDefinition {
  return { key, label, help, template, requiredProperties };
}

/** Markdown from lines, so templates read like the files they become. */
const lines = (...parts: string[]) => `${parts.join("\n")}\n`;

// Default page types: every space starts with these.

const OVERVIEW = pageType(
  "overview",
  "Overview",
  "What something is and why it matters; also the start page of a section.",
  lines("## In short", "", "## How it works", "", "## Where to go next", "", "- "),
);

const HOW_TO = pageType(
  "how-to",
  "How-to",
  "The steps to get one task done.",
  lines(
    "## Before you start",
    "",
    "- ",
    "",
    "## Steps",
    "",
    "1. ",
    "",
    "## Result",
    "",
    "## If it doesn't work",
  ),
);

const POLICY = pageType(
  "policy",
  "Policy",
  "Rules people must follow. Needs an owner and the date it was last reviewed.",
  lines(
    "## Purpose",
    "",
    "## Who it applies to",
    "",
    "## Rules",
    "",
    "1. ",
    "",
    "## Exceptions",
    "",
    "## Questions",
  ),
  ["owner", "reviewed"],
);

const REFERENCE = pageType(
  "reference",
  "Reference",
  "Facts to look up: contacts, lists, settings, terms.",
  lines("| Name | Details |", "| ---- | ------- |", "|      |         |", "", "## Sources"),
);

/** The page types every space starts with. */
export const DEFAULT_PAGE_TYPES: readonly PageTypeDefinition[] = [OVERVIEW, HOW_TO, POLICY, REFERENCE];

// Page types some templates add.

const TOOL = pageType(
  "tool",
  "Tool",
  "One app or system: what it is for, how to get access, and who helps.",
  lines(
    "## What it is for",
    "",
    "## How to get access",
    "",
    "## Common tasks",
    "",
    "- ",
    "",
    "## Permissions",
    "",
    "## Problems and help",
  ),
);

const TROUBLESHOOTING = pageType(
  "troubleshooting",
  "Troubleshooting",
  "One problem: what people see, and how to fix it.",
  lines(
    "## Symptoms",
    "",
    "## Quick checks",
    "",
    "- ",
    "",
    "## Fix",
    "",
    "1. ",
    "",
    "## When to ask for help",
    "",
    "## What to include when you ask",
    "",
    "- ",
  ),
);

const DECISION = pageType(
  "decision",
  "Decision",
  "What was decided, why, and what it changes. A replaced decision is deprecated and points to the new one.",
  lines("## Context", "", "## Options considered", "", "- ", "", "## Decision", "", "## Consequences"),
);

const BENEFIT = pageType(
  "benefit",
  "Benefit",
  "One benefit: what people get, who can use it, and how.",
  lines("## What you get", "", "## Who can use it", "", "## How to use it", "", "1. ", "", "## Questions"),
);

const RUNBOOK = pageType(
  "runbook",
  "Runbook",
  "Steps to run or repair a system, for whoever is on call.",
  lines(
    "## When to use this",
    "",
    "## Before you start",
    "",
    "- ",
    "",
    "## Steps",
    "",
    "1. ",
    "",
    "## Check that it worked",
    "",
    "## If it gets worse",
  ),
);

const SPEC = pageType(
  "spec",
  "Spec",
  "What we build and why: the problem, goals and requirements.",
  lines(
    "## Problem",
    "",
    "## Goals",
    "",
    "- ",
    "",
    "## Not in scope",
    "",
    "- ",
    "",
    "## Requirements",
    "",
    "1. ",
    "",
    "## Open questions",
    "",
    "- ",
  ),
);

const RESEARCH = pageType(
  "research",
  "Research",
  "What we wanted to learn, how we found out, and what we learned.",
  lines("## Question", "", "## Method", "", "## Findings", "", "1. ", "", "## What we do next"),
);

// Properties some templates add.

const SYSTEMS = property("systems", "Systems", "list", "Systems or services this page is about.");
const APPLIES_TO = property("applies_to", "Applies to", "multiselect", "Who this page is for.", [
  "Employees",
  "Interns",
  "Freelancers",
  "Volunteers",
]);
const EFFECTIVE_DATE = property(
  "effective_date",
  "In effect since",
  "date",
  "When the current rules took effect.",
);

/** A top-level page a template creates: the start page of one section. */
export type StarterPage = { slug: string; title: string; description: string; body: string };

export const SPACE_TEMPLATE_KEYS = [
  "blank",
  "team",
  "it",
  "people",
  "finance",
  "engineering",
  "product",
] as const;
export const spaceTemplateKeySchema = z.enum(SPACE_TEMPLATE_KEYS);
export type SpaceTemplateKey = z.infer<typeof spaceTemplateKeySchema>;

export type SpaceTemplate = {
  key: SpaceTemplateKey;
  label: string;
  description: string;
  properties: readonly PropertyDefinition[];
  /** The default page types first, then the template's own. */
  pageTypes: readonly PageTypeDefinition[];
  pages: readonly StarterPage[];
};

function template(
  key: SpaceTemplateKey,
  label: string,
  description: string,
  extra: { properties?: PropertyDefinition[]; pageTypes?: PageTypeDefinition[]; pages?: StarterPage[] },
): SpaceTemplate {
  return {
    key,
    label,
    description,
    properties: extra.properties ?? [],
    pageTypes: [...DEFAULT_PAGE_TYPES, ...(extra.pageTypes ?? [])],
    pages: extra.pages ?? [],
  };
}

const page = (slug: string, title: string, description: string, body: string): StarterPage => ({
  slug,
  title,
  description,
  body,
});

export const SPACE_TEMPLATES: Record<SpaceTemplateKey, SpaceTemplate> = {
  blank: template(
    "blank",
    "Blank",
    "Only the page types every space has: overview, how-to, policy and reference.",
    {},
  ),
  team: template("team", "Team", "A team's home: how it works, what it decided, and how new members start.", {
    pageTypes: [DECISION],
    pages: [
      page(
        "how-we-work",
        "How we work",
        "Our routines, tools and who does what.",
        "How we plan, meet, share work and hand it over.",
      ),
      page(
        "decisions",
        "Decisions",
        "What we decided, and why.",
        "One page per decision. When a decision is replaced, the old page points to the new one.",
      ),
      page(
        "joining-the-team",
        "Joining the team",
        "What new team members need in their first weeks.",
        "Who to meet, what to read, and which access to ask for.",
      ),
    ],
  }),
  it: template("it", "IT", "Software, how-to guides, help with problems, and IT policies.", {
    properties: [
      SYSTEMS,
      property("audience", "Audience", "multiselect", "Who this page is written for.", [
        "All staff",
        "New staff",
        "Managers",
        "IT team",
      ]),
    ],
    pageTypes: [TOOL, TROUBLESHOOTING],
    pages: [
      page(
        "software",
        "Software",
        "The apps and systems we use.",
        "Every app and system has a page here: what it is for, how to get access, and who helps.",
      ),
      page(
        "how-to-guides",
        "How-to guides",
        "Step-by-step tasks: accounts, devices, meeting rooms and more.",
        "Each guide covers one task from start to finish.",
      ),
      page(
        "onboarding-and-offboarding",
        "Onboarding and offboarding",
        "Accounts, devices and first steps for people who join, and what happens when they leave.",
        "Start here on your first day.",
      ),
      page(
        "help",
        "Help",
        "Fixes for common problems, and how to get support.",
        "Each page covers one problem: what you see, what to check, and how to fix it. If nothing here helps, ask the IT team.",
      ),
      page(
        "policies",
        "Policies",
        "Rules for using devices, accounts and data safely.",
        "These rules apply to everyone who uses our devices and accounts.",
      ),
      page(
        "it-team",
        "IT team",
        "Who looks after IT, what we are responsible for, and how to reach us.",
        "What the IT team does, and the best way to ask for help.",
      ),
    ],
  }),
  people: template("people", "People", "Joining, time off, pay and benefits, and HR policies.", {
    properties: [APPLIES_TO, EFFECTIVE_DATE],
    pageTypes: [BENEFIT],
    pages: [
      page(
        "joining-and-leaving",
        "Joining and leaving",
        "First days, probation, and what happens when someone leaves.",
        "What to expect in your first weeks, and the steps when you leave.",
      ),
      page(
        "time-off",
        "Time off",
        "Vacation, sick days, parental leave and public holidays.",
        "How much time off you have, and how to take it.",
      ),
      page(
        "pay-and-benefits",
        "Pay and benefits",
        "Salary, payslips and the benefits we offer.",
        "When you get paid, where to find your payslip, and what else we offer.",
      ),
      page(
        "working-here",
        "Working here",
        "Working hours, remote work, development and feedback.",
        "How we work together day to day.",
      ),
      page(
        "policies",
        "Policies",
        "Rules that apply to everyone who works here.",
        "Each policy says who it applies to and who to ask.",
      ),
    ],
  }),
  finance: template("finance", "Finance", "Expenses, purchases, budgets and spending rules.", {
    properties: [
      APPLIES_TO,
      EFFECTIVE_DATE,
      property("form", "Form or tool", "url", "Where people do this, e.g. the expense tool."),
    ],
    pages: [
      page(
        "expenses-and-travel",
        "Expenses and travel",
        "How to book trips and get back money you spent for work.",
        "What you can claim, how to claim it, and when the money arrives.",
      ),
      page(
        "purchases-and-invoices",
        "Purchases and invoices",
        "How to buy things, who approves them, and how invoices get paid.",
        "From the first quote to the paid invoice.",
      ),
      page(
        "budgets",
        "Budgets",
        "How budgets are planned and tracked.",
        "Who plans which budget, when, and how to see where it stands.",
      ),
      page(
        "policies",
        "Policies",
        "Spending rules, approval limits and who may sign.",
        "These rules apply whenever money is spent or a contract is signed.",
      ),
    ],
  }),
  engineering: template(
    "engineering",
    "Engineering",
    "Architecture, development practices, runbooks and technical decisions.",
    {
      properties: [SYSTEMS, property("repository", "Repository", "url", "Where the code lives.")],
      pageTypes: [RUNBOOK, DECISION],
      pages: [
        page(
          "architecture",
          "Architecture",
          "How our systems fit together.",
          "The systems we run, what each one does, and how they talk to each other.",
        ),
        page(
          "development",
          "Development",
          "How we write, review, test and release code.",
          "The practices every engineer follows, from the first commit to the release.",
        ),
        page(
          "runbooks",
          "Runbooks",
          "Steps to run our systems and repair them when they fail.",
          "One runbook per task or failure, written for whoever is on call.",
        ),
        page(
          "decisions",
          "Decisions",
          "Technical decisions and why we made them.",
          "One page per decision. When a decision is replaced, the old page points to the new one.",
        ),
      ],
    },
  ),
  product: template("product", "Product", "Strategy, specs, research and product decisions.", {
    properties: [
      property("stage", "Stage", "select", "Where the work stands.", [
        "Idea",
        "Discovery",
        "Building",
        "Released",
      ]),
    ],
    pageTypes: [SPEC, RESEARCH, DECISION],
    pages: [
      page(
        "strategy",
        "Strategy",
        "Where the product is going, and why.",
        "Our goals, who we build for, and what comes next.",
      ),
      page(
        "specs",
        "Specs",
        "What we build and why, one page per feature.",
        "Each spec starts with the problem it solves.",
      ),
      page(
        "research",
        "Research",
        "What we learned from users and data.",
        "Each page says what we wanted to learn, how we found out, and what we learned.",
      ),
      page(
        "decisions",
        "Decisions",
        "Product decisions and why we made them.",
        "One page per decision. When a decision is replaced, the old page points to the new one.",
      ),
    ],
  }),
};

/** The properties and page types a new space of this template starts with. */
export function templateSchema(key: SpaceTemplateKey): SpaceSchema {
  const { properties, pageTypes } = SPACE_TEMPLATES[key];
  return { properties: [...properties], pageTypes: [...pageTypes] };
}

/** The files of a template's starter pages, in order; each is a top-level overview page. */
export function starterPageFiles(key: SpaceTemplateKey): { slug: string; markdown: string }[] {
  const schema = templateSchema(key);
  return SPACE_TEMPLATES[key].pages.map((starter) => ({
    slug: starter.slug,
    markdown: serializePageFile(
      {
        frontmatter: {
          title: starter.title,
          description: starter.description,
          type: OVERVIEW.key,
          status: "active",
          tags: [],
          owner: null,
          reviewed: null,
          replaced_by: null,
          search_terms: [],
          custom: {},
        },
        body: starter.body,
      },
      schema,
    ),
  }));
}

/**
 * A space's schema with a template's properties and page types added: only
 * keys the space doesn't have yet, after its own. What the space has stays
 * as it is, also where the template defines the same key differently.
 */
export function addTemplateSchema(
  schema: SpaceSchema,
  key: SpaceTemplateKey,
): { schema: SpaceSchema; added: { properties: PropertyDefinition[]; pageTypes: PageTypeDefinition[] } } {
  const template = SPACE_TEMPLATES[key];
  const propertyKeys = new Set(schema.properties.map((definition) => definition.key));
  const typeKeys = new Set(schema.pageTypes.map((definition) => definition.key));
  const properties = template.properties.filter((definition) => !propertyKeys.has(definition.key));
  const pageTypes = template.pageTypes.filter((definition) => !typeKeys.has(definition.key));
  return {
    schema: {
      properties: [...schema.properties, ...properties],
      pageTypes: [...schema.pageTypes, ...pageTypes],
    },
    added: { properties, pageTypes },
  };
}
