import { z } from "zod";
import { isDocument, isMap, isScalar, parseDocument, stringify } from "yaml";
import { markdownProblem } from "./markdown";

/**
 * A page is one Markdown file: YAML frontmatter, then the body.
 *
 *   ---
 *   title: Email aliases
 *   tags:
 *     - email
 *   ---
 *
 *   Body in Markdown.
 *
 * The frontmatter holds the page's properties: the built-in ones below and
 * the custom ones its space defines. The server, the web editor and agents
 * use these functions, so every channel reads and writes files the same way.
 */

export const PAGE_STATUSES = ["draft", "active", "deprecated"] as const;
export const pageStatusSchema = z.enum(PAGE_STATUSES);
export type PageStatus = z.infer<typeof pageStatusSchema>;

export const PROPERTY_TYPES = [
  "text",
  "list",
  "number",
  "boolean",
  "date",
  "select",
  "multiselect",
  "url",
  "person",
] as const;
export const propertyTypeSchema = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof propertyTypeSchema>;

/** The built-in properties, in the order the frontmatter lists them. */
export const BUILT_IN_KEYS = [
  "title",
  "description",
  "type",
  "status",
  "tags",
  "owner",
  "reviewed",
  "replaced_by",
  "search_terms",
] as const;
export type BuiltInKey = (typeof BUILT_IN_KEYS)[number];

export const BUILT_IN_PROPERTIES: Record<BuiltInKey, { label: string; type: PropertyType; help: string }> = {
  title: { label: "Title", type: "text", help: "Required. The page's name." },
  description: { label: "Description", type: "text", help: "One sentence; shown in lists and search." },
  type: { label: "Page type", type: "select", help: "One of the space's page types." },
  status: { label: "Status", type: "select", help: "draft (only editors see it), active, or deprecated." },
  tags: { label: "Tags", type: "list", help: "Words that group pages across spaces; lowercase." },
  owner: { label: "Owner", type: "person", help: "Email address of the person who keeps the page correct." },
  reviewed: { label: "Last reviewed", type: "date", help: "YYYY-MM-DD: when someone last checked the page." },
  replaced_by: { label: "Replaced by", type: "text", help: "Path of the page that replaces this one." },
  search_terms: {
    label: "Search terms",
    type: "list",
    help: "Other words people search for, e.g. in other languages.",
  },
};

/** Built-in properties a page type may require (title is always required; status has a default). */
export const REQUIRABLE_BUILT_IN_KEYS = ["description", "tags", "owner", "reviewed", "search_terms"] as const;
export type RequirableBuiltInKey = (typeof REQUIRABLE_BUILT_IN_KEYS)[number];

export function isRequirableBuiltIn(key: string): key is RequirableBuiltInKey {
  return (REQUIRABLE_BUILT_IN_KEYS as readonly string[]).includes(key);
}

export const PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const propertyDefinitionSchema = z
  .object({
    key: z
      .string()
      .regex(PROPERTY_KEY_PATTERN, "Use 1 to 40 lowercase letters, digits or _, starting with a letter")
      .refine((key) => !(BUILT_IN_KEYS as readonly string[]).includes(key), "This is a built-in property"),
    label: z.string().trim().min(1, "Add a label").max(60),
    type: propertyTypeSchema,
    /** Allowed values of select and multiselect. */
    options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    required: z.boolean().default(false),
    help: z.string().trim().max(200).default(""),
  })
  .superRefine((value, ctx) => {
    if ((value.type === "select" || value.type === "multiselect") && value.options.length === 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Add at least one option" });
    }
    if (new Set(value.options).size !== value.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
    }
  });
export type PropertyDefinition = z.infer<typeof propertyDefinitionSchema>;

export const PAGE_TYPE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export const pageTypeDefinitionSchema = z.object({
  key: z
    .string()
    .regex(PAGE_TYPE_KEY_PATTERN, "Use 1 to 40 lowercase letters, digits or -, starting with a letter"),
  label: z.string().trim().min(1, "Add a label").max(60),
  /** What pages of this type are for; shown when choosing a type. Missing on types saved before it existed. */
  help: z.string().trim().max(200).optional(),
  /** Markdown body a new page of this type starts with. */
  template: z.string().max(20_000).default(""),
  /** Property keys a page of this type must have: the space's own, or requirable built-in ones. */
  requiredProperties: z.array(z.string()).max(50).default([]),
});
export type PageTypeDefinition = z.infer<typeof pageTypeDefinitionSchema>;

/** What a space defines for its pages. */
export type SpaceSchema = {
  properties: PropertyDefinition[];
  pageTypes: PageTypeDefinition[];
};

export const EMPTY_SPACE_SCHEMA: SpaceSchema = { properties: [], pageTypes: [] };

/** Checks a space's properties and page types together (unique keys, known required properties). */
export function spaceSchemaProblems(schema: SpaceSchema): Record<string, string> {
  const problems: Record<string, string> = {};
  const keys = new Set<string>();
  schema.properties.forEach((property, index) => {
    if (keys.has(property.key)) problems[`properties.${index}.key`] = "This key is used twice";
    keys.add(property.key);
  });
  const types = new Set<string>();
  schema.pageTypes.forEach((pageType, index) => {
    if (types.has(pageType.key)) problems[`pageTypes.${index}.key`] = "This key is used twice";
    types.add(pageType.key);
    for (const key of pageType.requiredProperties) {
      if (!keys.has(key) && !isRequirableBuiltIn(key)) {
        problems[`pageTypes.${index}.requiredProperties`] = `Unknown property “${key}”`;
      }
    }
  });
  return problems;
}

/** A property value as stored: frontmatter values are strings, numbers, booleans or lists of strings. */
export type PropertyValue = string | number | boolean | string[];
export type Properties = Record<string, PropertyValue>;

/** The validated frontmatter of a page. */
export type PageFrontmatter = {
  title: string;
  description: string | null;
  type: string | null;
  status: PageStatus;
  tags: string[];
  owner: string | null;
  reviewed: string | null;
  replaced_by: string | null;
  search_terms: string[];
  /** Custom properties of the space, by key. */
  custom: Properties;
};

export type ParsedPage = { frontmatter: PageFrontmatter; body: string };

export type PageParseResult = { ok: true; page: ParsedPage } | { ok: false; errors: Record<string, string> };

// The closing `---` is a line of its own: a value that ends in `---` does not end the frontmatter.
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An email address has at most 254 characters (longer text also makes the pattern slow). */
function isEmail(text: string): boolean {
  return text.length <= 254 && EMAIL.test(text);
}

/** Splits a file into its raw frontmatter text and body; null when it has no frontmatter. */
export function splitFrontmatter(markdown: string): { yaml: string; body: string } | null {
  const text = normalizeNewlines(markdown).replace(/^\uFEFF/, "");
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  return { yaml: match[1] ?? "", body: text.slice(match[0].length) };
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Reads the raw frontmatter mapping (no validation); null when the YAML is not a mapping. */
export function readFrontmatterValues(
  yamlText: string,
): { values: Record<string, unknown> } | { error: string } {
  if (yamlText.trim() === "") return { values: {} };
  // Keys are checked below: the parser's own check takes quadratic time.
  const document = parseDocument(yamlText, { schema: "core", uniqueKeys: false, prettyErrors: false });
  if (!isDocument(document) || document.errors.length > 0) {
    const first = document.errors[0];
    return { error: `The frontmatter is not valid YAML${first ? `: ${first.message.split("\n")[0]}` : ""}` };
  }
  if (isMap(document.contents)) {
    const keys = new Set<string>();
    for (const { key } of document.contents.items) {
      const name = isScalar(key) ? String(key.value) : String(key);
      if (keys.has(name)) return { error: "The frontmatter is not valid YAML: Map keys must be unique" };
      keys.add(name);
    }
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { error: "The frontmatter is not valid YAML: aliases (*name) are not supported" };
  }
  if (value === null || value === undefined) return { values: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "The frontmatter must be a list of `key: value` lines" };
  }
  return { values: value as Record<string, unknown> };
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function asList(value: unknown): string[] | null {
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    const text = asText(item);
    if (text === null) return null;
    if (text) items.push(text);
  }
  return items;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Normalizes a tag: trimmed, lowercase, inner spaces collapsed. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Validates frontmatter values against the built-in properties and a
 * space's schema. Errors are keyed `properties.<key>`.
 */
export function validateFrontmatter(
  values: Record<string, unknown>,
  schema: SpaceSchema,
): { ok: true; frontmatter: PageFrontmatter } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const fail = (key: string, message: string) => {
    errors[`properties.${key}`] ??= message;
  };

  const title = asText(values.title);
  if (!title) fail("title", "Add a title");
  else if (title.length > 200) fail("title", "Use at most 200 characters");

  const description = isBlank(values.description) ? null : asText(values.description);
  if (!isBlank(values.description) && description === null) fail("description", "Use text");
  else if (description && description.length > 500) fail("description", "Use at most 500 characters");

  let type: string | null = null;
  if (!isBlank(values.type)) {
    type = asText(values.type);
    if (!type || !schema.pageTypes.some((pageType) => pageType.key === type)) {
      const known = schema.pageTypes.map((pageType) => pageType.key);
      fail(
        "type",
        known.length > 0
          ? `Use one of the space's page types: ${known.join(", ")}`
          : "This space has no page types; remove `type`",
      );
    }
  }

  let status: PageStatus = "active";
  if (!isBlank(values.status)) {
    const parsed = pageStatusSchema.safeParse(asText(values.status));
    if (parsed.success) status = parsed.data;
    else fail("status", "Use draft, active or deprecated");
  }

  const tags: string[] = [];
  if (!isBlank(values.tags)) {
    const list = asList(values.tags);
    if (!list) fail("tags", "Use a list of words");
    else {
      for (const raw of list) {
        const tag = normalizeTag(raw);
        if (tag.length > 50) fail("tags", "Each tag may have at most 50 characters");
        else if (!tags.includes(tag)) tags.push(tag);
      }
      if (tags.length > 30) fail("tags", "Use at most 30 tags");
    }
  }

  let owner: string | null = null;
  if (!isBlank(values.owner)) {
    owner = asText(values.owner)?.toLowerCase() ?? null;
    if (!owner || !isEmail(owner)) fail("owner", "Use an email address");
  }

  let reviewed: string | null = null;
  if (!isBlank(values.reviewed)) {
    reviewed = asText(values.reviewed);
    if (!reviewed || !isValidDate(reviewed)) fail("reviewed", "Use a date like 2026-11-17");
  }

  let replacedBy: string | null = null;
  if (!isBlank(values.replaced_by)) {
    replacedBy = asText(values.replaced_by);
    if (!replacedBy || replacedBy.length > 400) fail("replaced_by", "Use the path of a page");
  }

  const searchTerms: string[] = [];
  if (!isBlank(values.search_terms)) {
    const list = asList(values.search_terms);
    if (!list) fail("search_terms", "Use a list of words or phrases");
    else {
      for (const term of list) {
        if (term.length > 100) fail("search_terms", "Each term may have at most 100 characters");
        else if (!searchTerms.includes(term)) searchTerms.push(term);
      }
      if (searchTerms.length > 50) fail("search_terms", "Use at most 50 terms");
    }
  }

  const custom: Properties = {};
  const definitions = new Map(schema.properties.map((property) => [property.key, property]));
  for (const [key, value] of Object.entries(values)) {
    if ((BUILT_IN_KEYS as readonly string[]).includes(key)) continue;
    const definition = definitions.get(key);
    if (!definition) {
      const known = schema.properties.map((property) => property.key);
      fail(
        key,
        known.length > 0
          ? `Unknown property “${key}”. This space defines: ${known.join(", ")}`
          : `Unknown property “${key}”. This space defines no custom properties`,
      );
      continue;
    }
    if (isBlank(value)) continue;
    const result = validateCustomValue(definition, value);
    if ("error" in result) fail(key, result.error);
    else custom[key] = result.value;
  }

  for (const definition of schema.properties) {
    if (definition.required && custom[definition.key] === undefined) {
      fail(definition.key, `Add “${definition.label}”`);
    }
  }
  if (type) {
    const pageType = schema.pageTypes.find((candidate) => candidate.key === type);
    const builtIn: Record<RequirableBuiltInKey, boolean> = {
      description: description !== null,
      tags: tags.length > 0,
      owner: owner !== null,
      reviewed: reviewed !== null,
      search_terms: searchTerms.length > 0,
    };
    for (const key of pageType?.requiredProperties ?? []) {
      const present = isRequirableBuiltIn(key) ? builtIn[key] : custom[key] !== undefined;
      if (!present) {
        const label = isRequirableBuiltIn(key)
          ? BUILT_IN_PROPERTIES[key].label
          : (definitions.get(key)?.label ?? key);
        fail(key, `Pages of type “${pageType?.label ?? type}” need “${label}”`);
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    frontmatter: {
      title: title ?? "",
      description,
      type,
      status,
      tags,
      owner,
      reviewed,
      replaced_by: replacedBy,
      search_terms: searchTerms,
      custom,
    },
  };
}

function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function validateCustomValue(
  definition: PropertyDefinition,
  value: unknown,
): { value: PropertyValue } | { error: string } {
  switch (definition.type) {
    case "text": {
      const text = asText(value);
      if (text === null) return { error: "Use text" };
      if (text.length > 1000) return { error: "Use at most 1000 characters" };
      return { value: text };
    }
    case "list": {
      const list = asList(value);
      if (!list) return { error: "Use a list of words or phrases" };
      if (list.length > 50 || list.some((item) => item.length > 200)) {
        return { error: "Use at most 50 items of 200 characters" };
      }
      return { value: list };
    }
    case "number": {
      const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (!Number.isFinite(number)) return { error: "Use a number" };
      return { value: number };
    }
    case "boolean": {
      if (typeof value === "boolean") return { value };
      if (value === "true" || value === "false") return { value: value === "true" };
      return { error: "Use true or false" };
    }
    case "date": {
      const text = asText(value);
      if (!text || !isValidDate(text)) return { error: "Use a date like 2026-11-17" };
      return { value: text };
    }
    case "select": {
      const text = asText(value);
      if (!text || !definition.options.includes(text)) {
        return { error: `Use one of: ${definition.options.join(", ")}` };
      }
      return { value: text };
    }
    case "multiselect": {
      const list = asList(value);
      const unknown = list?.filter((item) => !definition.options.includes(item)) ?? [];
      if (!list || unknown.length > 0) return { error: `Use values from: ${definition.options.join(", ")}` };
      return { value: [...new Set(list)] };
    }
    case "url": {
      const text = asText(value);
      if (!text || !isUrl(text)) return { error: "Use a web address starting with https://" };
      return { value: text };
    }
    case "person": {
      const text = asText(value)?.toLowerCase();
      if (!text || !isEmail(text)) return { error: "Use an email address" };
      return { value: text };
    }
  }
}

/** Parses and validates a whole page file. */
export function parsePageFile(markdown: string, schema: SpaceSchema): PageParseResult {
  if (markdown.length > MAX_PAGE_CHARACTERS) {
    return { ok: false, errors: { markdown: `A page may have at most ${MAX_PAGE_CHARACTERS} characters` } };
  }
  const parts = splitFrontmatter(markdown);
  if (!parts) {
    return {
      ok: false,
      errors: {
        markdown: "Start the file with frontmatter: a `---` line, `title: …`, and another `---` line",
      },
    };
  }
  const read = readFrontmatterValues(parts.yaml);
  if ("error" in read) return { ok: false, errors: { markdown: read.error } };
  const validated = validateFrontmatter(read.values, schema);
  if (!validated.ok) return validated;
  const body = normalizeBody(parts.body);
  // Line numbers in the message count from the start of the file.
  const text = normalizeNewlines(markdown).replace(/^\uFEFF/, "");
  const before =
    text.slice(0, text.length - parts.body.length) + (/^(?:[ \t]*\n)+/.exec(parts.body)?.[0] ?? "");
  const problem = markdownProblem(body, before.split("\n").length);
  if (problem) return { ok: false, errors: { markdown: problem } };
  return { ok: true, page: { frontmatter: validated.frontmatter, body } };
}

export const MAX_PAGE_CHARACTERS = 500_000;

/** The body as stored: Unix line endings, no blank lines at the start, one newline at the end. */
export function normalizeBody(body: string): string {
  const text = normalizeNewlines(body)
    .replace(/^(?:[ \t]*\n)+/, "")
    // Not /\s+$/: a regex takes quadratic time on long runs of spaces inside the text.
    .trimEnd();
  return text === "" ? "" : `${text}\n`;
}

/** The frontmatter as an ordered plain object: built-in keys first, then custom keys in schema order. */
export function frontmatterObject(
  frontmatter: PageFrontmatter,
  schema: SpaceSchema,
): Record<string, unknown> {
  const result: Record<string, unknown> = { title: frontmatter.title };
  if (frontmatter.description) result.description = frontmatter.description;
  if (frontmatter.type) result.type = frontmatter.type;
  if (frontmatter.status !== "active") result.status = frontmatter.status;
  if (frontmatter.tags.length > 0) result.tags = frontmatter.tags;
  if (frontmatter.owner) result.owner = frontmatter.owner;
  if (frontmatter.reviewed) result.reviewed = frontmatter.reviewed;
  if (frontmatter.replaced_by) result.replaced_by = frontmatter.replaced_by;
  if (frontmatter.search_terms.length > 0) result.search_terms = frontmatter.search_terms;
  const order = schema.properties.map((property) => property.key);
  const customKeys = Object.keys(frontmatter.custom).sort((a, b) => {
    const indexA = order.indexOf(a);
    const indexB = order.indexOf(b);
    return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB) || a.localeCompare(b);
  });
  for (const key of customKeys) result[key] = frontmatter.custom[key];
  return result;
}

/** Writes a page file in the one canonical form every channel stores. */
export function serializePageFile(page: ParsedPage, schema: SpaceSchema): string {
  const yaml = stringify(frontmatterObject(page.frontmatter, schema), {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
  const body = normalizeBody(page.body);
  return `---\n${yaml}---\n${body ? `\n${body}` : ""}`;
}

/** Parses, validates and writes a file in canonical form. */
export function canonicalPageFile(
  markdown: string,
  schema: SpaceSchema,
): { ok: true; markdown: string; page: ParsedPage } | { ok: false; errors: Record<string, string> } {
  const parsed = parsePageFile(markdown, schema);
  if (!parsed.ok) return parsed;
  return { ok: true, markdown: serializePageFile(parsed.page, schema), page: parsed.page };
}

/** A new page file with a title and a body (e.g. a page type's template). */
export function newPageFile(
  input: { title: string; type?: string | null; status?: PageStatus; body?: string },
  schema: SpaceSchema,
): string {
  return serializePageFile(
    {
      frontmatter: {
        title: input.title,
        description: null,
        type: input.type ?? null,
        status: input.status ?? "active",
        tags: [],
        owner: null,
        reviewed: null,
        replaced_by: null,
        search_terms: [],
        custom: {},
      },
      body: input.body ?? "",
    },
    schema,
  );
}

/**
 * Replaces the frontmatter of a file with new values and keeps the body.
 * Used by forms that edit properties without touching the text.
 */
export function withFrontmatter(markdown: string, values: Record<string, unknown>): string {
  const parts = splitFrontmatter(markdown);
  const body = parts ? parts.body : markdown;
  const cleaned = Object.fromEntries(Object.entries(values).filter(([, value]) => !isBlank(value)));
  const yaml = Object.keys(cleaned).length > 0 ? stringify(cleaned, { lineWidth: 0 }) : "";
  const normalized = normalizeBody(body);
  return `---\n${yaml}---\n${normalized ? `\n${normalized}` : ""}`;
}
