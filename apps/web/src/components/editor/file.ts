import { stringify } from "yaml";
import {
  BUILT_IN_KEYS,
  readFrontmatterValues,
  splitFrontmatter,
  type SpaceSchema,
} from "@handbook/shared/page";

/**
 * The editor keeps the whole page file as one string and edits two views of
 * it: the frontmatter as form values and the body as text. These helpers
 * split and join the file without touching the other part.
 */

export type FileParts = { yaml: string | null; body: string };

export function splitFile(file: string): FileParts {
  const parts = splitFrontmatter(file);
  return parts ? { yaml: parts.yaml, body: parts.body } : { yaml: null, body: file };
}

/** Joins frontmatter text and body; the body is kept exactly as written. */
export function joinFile(yaml: string | null, body: string): string {
  if (yaml === null) return body;
  const text = yaml.replace(/\n+$/, "");
  return `---\n${text}${text ? "\n" : ""}---\n${body}`;
}

/** The body for the text editor: without the blank line after the frontmatter. */
export function bodyOf(file: string): string {
  return splitFile(file).body.replace(/^\n/, "");
}

/** Replaces the body, keeping the frontmatter text as it is. */
export function withBody(file: string, body: string): string {
  const { yaml } = splitFile(file);
  return joinFile(yaml ?? "", body === "" ? "" : `\n${body}`);
}

export type Values = Record<string, unknown>;

/** The frontmatter values, or an error when the YAML cannot be read. */
export function valuesOf(file: string): { values: Values } | { error: string } {
  const { yaml } = splitFile(file);
  if (yaml === null) return { values: {} };
  return readFrontmatterValues(yaml);
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Values in the order files list them: built-ins, the space's properties, then the rest. */
export function orderedValues(values: Values, schema: SpaceSchema): Values {
  const order = [...BUILT_IN_KEYS, ...schema.properties.map((property) => property.key)];
  const keys = Object.keys(values).sort((a, b) => {
    const indexA = order.indexOf(a as never);
    const indexB = order.indexOf(b as never);
    return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
  });
  const result: Values = {};
  for (const key of keys) if (!isBlank(values[key])) result[key] = values[key];
  return result;
}

/** Replaces the frontmatter with new values and keeps the body exactly. */
export function withValues(file: string, values: Values, schema: SpaceSchema): string {
  const ordered = orderedValues(values, schema);
  const yaml = Object.keys(ordered).length > 0 ? stringify(ordered, { lineWidth: 0 }) : "";
  return joinFile(yaml, splitFile(file).body);
}

/** Splits a comma-separated input into trimmed items. */
export function splitComma(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Splits a one-per-line input into trimmed items. */
export function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A frontmatter value as a list of strings (a single string is one item). */
export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

/** A frontmatter value as text for an input. */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}
