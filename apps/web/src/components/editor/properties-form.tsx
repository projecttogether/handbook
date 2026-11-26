import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import {
  BUILT_IN_KEYS,
  BUILT_IN_PROPERTIES,
  PAGE_STATUSES,
  type PropertyDefinition,
  type SpaceSchema,
} from "@handbook/shared/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { defineMessages, useT } from "@/i18n";
import { asList, asText, splitComma, splitLines, type Values } from "./file";

export const propertyMessages = defineMessages({
  en: {
    none: "None",
    draft: "Draft (only editors see it)",
    active: "Active",
    deprecated: "Deprecated",
    spaceProperties: "Properties of this space",
    unknown: "Not defined in this space",
    unknownHelp:
      "The space does not define “{key}”. Remove it, or ask an owner to add it in the space settings.",
    remove: "Remove {key}",
    commaHelp: "Separate with commas.",
    linesHelp: "One per line.",
    yes: "Yes",
  },
});

const NONE = "__none";

/** Errors of the save answer, by property key (`properties.<key>`). */
export function propertyErrors(fields: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, message] of Object.entries(fields ?? {})) {
    if (key.startsWith("properties.")) result[key.slice("properties.".length)] = message;
  }
  return result;
}

/** A text input that edits a list (comma- or line-separated) and keeps what the person types. */
function ListInput(props: {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  multiline: boolean;
  invalid: boolean;
  disabled?: boolean;
}) {
  const join = (items: string[]) => items.join(props.multiline ? "\n" : ", ");
  const split = props.multiline ? splitLines : splitComma;
  const [text, setText] = useState(() => join(props.value));
  useEffect(() => {
    // Follow outside changes (source view, restore), not the person's own typing.
    setText((current) => (join(split(current)) === join(props.value) ? current : join(props.value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value.join("\u0000")]);
  const change = (next: string) => {
    setText(next);
    props.onChange(split(next));
  };
  return props.multiline ? (
    <Textarea
      id={props.id}
      rows={3}
      value={text}
      disabled={props.disabled}
      aria-invalid={props.invalid}
      onChange={(event) => change(event.target.value)}
    />
  ) : (
    <Input
      id={props.id}
      value={text}
      disabled={props.disabled}
      aria-invalid={props.invalid}
      onChange={(event) => change(event.target.value)}
    />
  );
}

type FieldSpec = {
  key: string;
  label: string;
  help: string;
  type: PropertyDefinition["type"];
  options: string[];
  optionLabels?: Record<string, string>;
  required?: boolean;
  wide?: boolean;
  separator?: "comma" | "lines";
};

function PropertyField(props: {
  spec: FieldSpec;
  value: unknown;
  error: string | undefined;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useT(propertyMessages);
  const id = useId();
  const { spec } = props;
  const invalid = Boolean(props.error);
  let control;
  switch (spec.type) {
    case "list":
      control = (
        <ListInput
          id={id}
          value={asList(props.value)}
          multiline={spec.separator !== "comma"}
          invalid={invalid}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      );
      break;
    case "multiselect": {
      const selected = asList(props.value);
      control = (
        <div className="flex flex-wrap gap-x-4 gap-y-2" role="group" aria-labelledby={`${id}-label`}>
          {spec.options.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.includes(option)}
                disabled={props.disabled}
                onCheckedChange={(checked) =>
                  props.onChange(checked ? [...selected, option] : selected.filter((item) => item !== option))
                }
              />
              {option}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "select": {
      const value = asText(props.value);
      control = (
        <Select
          value={value === "" ? NONE : value}
          disabled={props.disabled}
          onValueChange={(next) => props.onChange(next === NONE ? null : next)}
        >
          <SelectTrigger id={id} className="w-full" aria-invalid={invalid}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {spec.required ? null : <SelectItem value={NONE}>{t("none")}</SelectItem>}
            {/* A stored value the space does not offer (any more) stays visible. */}
            {value && !spec.options.includes(value) ? <SelectItem value={value}>{value}</SelectItem> : null}
            {spec.options.map((option) => (
              <SelectItem key={option} value={option}>
                {spec.optionLabels?.[option] ?? option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      break;
    }
    case "boolean":
      control = (
        <div className="flex h-9 items-center gap-2">
          <Switch
            id={id}
            checked={props.value === true || props.value === "true"}
            disabled={props.disabled}
            onCheckedChange={(checked) => props.onChange(checked ? true : null)}
          />
          <span className="text-muted-foreground text-sm">{t("yes")}</span>
        </div>
      );
      break;
    case "number":
      control = (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={asText(props.value)}
          disabled={props.disabled}
          aria-invalid={invalid}
          onChange={(event) => props.onChange(event.target.value === "" ? null : Number(event.target.value))}
        />
      );
      break;
    case "date":
      control = (
        <Input
          id={id}
          type="date"
          value={asText(props.value)}
          disabled={props.disabled}
          aria-invalid={invalid}
          onChange={(event) => props.onChange(event.target.value || null)}
        />
      );
      break;
    default: {
      const multiline = spec.key === "description";
      const inputType = spec.type === "url" ? "url" : spec.type === "person" ? "email" : "text";
      control = multiline ? (
        <Textarea
          id={id}
          rows={2}
          value={asText(props.value)}
          disabled={props.disabled}
          aria-invalid={invalid}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={inputType}
          value={asText(props.value)}
          disabled={props.disabled}
          aria-invalid={invalid}
          required={spec.required}
          onChange={(event) => props.onChange(event.target.value)}
        />
      );
    }
  }
  const help =
    spec.help || (spec.type === "list" ? (spec.separator === "comma" ? t("commaHelp") : t("linesHelp")) : "");
  return (
    <Field data-invalid={invalid} className={spec.wide ? "md:col-span-2" : undefined}>
      <FieldLabel htmlFor={id} id={`${id}-label`}>
        {spec.label}
      </FieldLabel>
      {control}
      {help ? <FieldDescription>{help}</FieldDescription> : null}
      {props.error ? <FieldError>{props.error}</FieldError> : null}
    </Field>
  );
}

/** The fields of the built-in properties, with the space's page types. */
function builtInSpecs(schema: SpaceSchema, statusLabels: Record<string, string>): FieldSpec[] {
  return BUILT_IN_KEYS.flatMap((key): FieldSpec[] => {
    const builtIn = BUILT_IN_PROPERTIES[key];
    const base = {
      key,
      label: builtIn.label,
      help: builtIn.help,
      type: builtIn.type,
      options: [] as string[],
    };
    switch (key) {
      case "title":
        return [{ ...base, help: "", required: true, wide: true }];
      case "description":
        return [{ ...base, wide: true }];
      case "type":
        if (schema.pageTypes.length === 0) return [];
        return [
          {
            ...base,
            help: "",
            options: schema.pageTypes.map((pageType) => pageType.key),
            optionLabels: Object.fromEntries(
              schema.pageTypes.map((pageType) => [pageType.key, pageType.label]),
            ),
          },
        ];
      case "status":
        return [
          { ...base, help: "", options: [...PAGE_STATUSES], optionLabels: statusLabels, required: true },
        ];
      case "tags":
        return [{ ...base, separator: "comma" }];
      case "search_terms":
        return [{ ...base, separator: "lines", wide: true }];
      default:
        return [base];
    }
  });
}

/**
 * Edits a page's frontmatter as a form: the built-in properties, then the
 * space's own. Errors come keyed by property (`propertyErrors`).
 */
export function PropertiesForm(props: {
  values: Values;
  onChange: (values: Values) => void;
  schema: SpaceSchema;
  errors?: Record<string, string>;
  disabled?: boolean;
  /** Properties edited elsewhere (e.g. the title on the page itself). */
  omit?: string[];
  /** One column, for narrow places like the settings sheet. */
  single?: boolean;
}) {
  const t = useT(propertyMessages);
  const statusLabels = { draft: t("draft"), active: t("active"), deprecated: t("deprecated") };
  const set = (key: string, value: unknown) => props.onChange({ ...props.values, [key]: value });
  const builtIns = builtInSpecs(props.schema, statusLabels)
    .filter((spec) => !props.omit?.includes(spec.key))
    .map((spec) => (props.single ? { ...spec, wide: false } : spec));
  const grid = props.single ? "grid gap-5" : "grid gap-4 md:grid-cols-2";
  const custom: FieldSpec[] = props.schema.properties.map((property) => ({
    key: property.key,
    label: property.label,
    help: property.help,
    type: property.type,
    options: property.options,
    required: property.required,
  }));
  const known = new Set<string>([...BUILT_IN_KEYS, ...custom.map((spec) => spec.key)]);
  const unknown = Object.keys(props.values).filter((key) => !known.has(key));
  const valueOf = (key: string) => (key === "status" ? (props.values.status ?? "active") : props.values[key]);

  return (
    <div className="space-y-6">
      <div className={grid}>
        {builtIns.map((spec) => (
          <PropertyField
            key={spec.key}
            spec={spec}
            value={valueOf(spec.key)}
            error={props.errors?.[spec.key]}
            disabled={props.disabled}
            onChange={(value) => set(spec.key, spec.key === "status" && value === "active" ? null : value)}
          />
        ))}
      </div>
      {custom.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">{t("spaceProperties")}</h3>
          <div className={grid}>
            {custom.map((spec) => (
              <PropertyField
                key={spec.key}
                spec={spec}
                value={props.values[spec.key]}
                error={props.errors?.[spec.key]}
                disabled={props.disabled}
                onChange={(value) => set(spec.key, value)}
              />
            ))}
          </div>
        </section>
      ) : null}
      {unknown.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("unknown")}</h3>
          {unknown.map((key) => (
            <div
              key={key}
              className="border-destructive/40 flex items-start justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0 text-sm">
                <p className="font-mono">
                  {key}: {asText(props.values[key])}
                </p>
                <p className="text-muted-foreground">{props.errors?.[key] ?? t("unknownHelp", { key })}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("remove", { key })}
                disabled={props.disabled}
                onClick={() => {
                  const next = { ...props.values };
                  delete next[key];
                  props.onChange(next);
                }}
              >
                <X />
              </Button>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
