import type { PageTypeDefinition, PropertyDefinition, PropertyType } from "@handbook/shared/page";
import { slugify } from "@handbook/shared/paths";
import { splitComma } from "@/components/editor/file";

/** A property as the settings form edits it (options as comma-separated text). */
export type PropertyRow = {
  id: string;
  /** Saved before: its key stays when the label changes (pages may use it). */
  saved: boolean;
  key: string;
  label: string;
  type: PropertyType;
  optionsText: string;
  required: boolean;
  help: string;
};

export type PageTypeRow = {
  id: string;
  /** Saved before: its key stays when the label changes (pages may use it). */
  saved: boolean;
  key: string;
  label: string;
  help: string;
  template: string;
  requiredProperties: string[];
};

let counter = 0;
const nextId = () => `row-${++counter}`;

export const hasOptions = (type: PropertyType) => type === "select" || type === "multiselect";

export function propertyRows(definitions: PropertyDefinition[]): PropertyRow[] {
  return definitions.map((definition) => ({
    id: nextId(),
    saved: true,
    key: definition.key,
    label: definition.label,
    type: definition.type,
    optionsText: definition.options.join(", "),
    required: definition.required,
    help: definition.help,
  }));
}

export function emptyPropertyRow(): PropertyRow {
  return {
    id: nextId(),
    saved: false,
    key: "",
    label: "",
    type: "text",
    optionsText: "",
    required: false,
    help: "",
  };
}

export function propertyDefinitions(rows: PropertyRow[]): PropertyDefinition[] {
  return rows.map((row) => ({
    key: row.key.trim(),
    label: row.label.trim(),
    type: row.type,
    options: hasOptions(row.type) ? splitComma(row.optionsText) : [],
    required: row.required,
    help: row.help.trim(),
  }));
}

export function pageTypeRows(definitions: PageTypeDefinition[]): PageTypeRow[] {
  return definitions.map((definition) => ({
    id: nextId(),
    saved: true,
    key: definition.key,
    label: definition.label,
    help: definition.help ?? "",
    template: definition.template,
    requiredProperties: [...definition.requiredProperties],
  }));
}

export function emptyPageTypeRow(): PageTypeRow {
  return { id: nextId(), saved: false, key: "", label: "", help: "", template: "", requiredProperties: [] };
}

export function pageTypeDefinitions(rows: PageTypeRow[]): PageTypeDefinition[] {
  return rows.map((row) => ({
    key: row.key.trim(),
    label: row.label.trim(),
    help: row.help.trim(),
    template: row.template,
    requiredProperties: row.requiredProperties,
  }));
}

/** A key from a label: "Review date" → "review_date" (properties) or "review-date" (page types). */
export function keyFromLabel(label: string, separator: "_" | "-"): string {
  return slugify(label, "")
    .replace(/^[0-9-]+/, "")
    .slice(0, 40)
    .replace(/-+$/, "")
    .replace(/-/g, separator);
}

/** Field errors of a list (`properties.2.key`) by row index and field. */
export function rowErrors(
  fields: Record<string, string> | undefined,
  list: string,
): Record<number, Record<string, string>> {
  const result: Record<number, Record<string, string>> = {};
  for (const [path, message] of Object.entries(fields ?? {})) {
    const match = new RegExp(`^${list}\\.(\\d+)(?:\\.(\\w+))?`).exec(path);
    if (!match) continue;
    const index = Number(match[1]);
    result[index] ??= {};
    result[index][match[2] ?? "_"] ??= message;
  }
  return result;
}

/** Moves an item one place up (-1) or down (+1). */
export function moved<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
