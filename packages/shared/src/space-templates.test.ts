import { describe, expect, it } from "vitest";
import {
  pageTypeDefinitionSchema,
  parsePageFile,
  propertyDefinitionSchema,
  spaceSchemaProblems,
} from "./page";
import { isValidSlug } from "./paths";
import {
  DEFAULT_PAGE_TYPES,
  SPACE_TEMPLATE_KEYS,
  SPACE_TEMPLATES,
  addTemplateSchema,
  starterPageFiles,
  templateSchema,
} from "./space-templates";

describe("space templates", () => {
  it.each(SPACE_TEMPLATE_KEYS)("%s is a valid space schema with valid starter pages", (key) => {
    const schema = templateSchema(key);
    for (const property of schema.properties)
      expect(propertyDefinitionSchema.parse(property)).toEqual(property);
    for (const pageType of schema.pageTypes)
      expect(pageTypeDefinitionSchema.parse(pageType)).toEqual(pageType);
    expect(spaceSchemaProblems(schema)).toEqual({});

    const files = starterPageFiles(key);
    expect(new Set(files.map((file) => file.slug)).size).toBe(files.length);
    for (const file of files) {
      expect(isValidSlug(file.slug)).toBe(true);
      const parsed = parsePageFile(file.markdown, schema);
      expect(parsed.ok && parsed.page.frontmatter).toMatchObject({ type: "overview", status: "active" });
    }
  });

  it("starts every template with the default page types", () => {
    for (const key of SPACE_TEMPLATE_KEYS) {
      expect(SPACE_TEMPLATES[key].pageTypes.slice(0, DEFAULT_PAGE_TYPES.length)).toEqual(DEFAULT_PAGE_TYPES);
    }
    expect(DEFAULT_PAGE_TYPES.map((pageType) => pageType.key)).toEqual([
      "overview",
      "how-to",
      "policy",
      "reference",
    ]);
    expect(templateSchema("blank")).toEqual({ properties: [], pageTypes: DEFAULT_PAGE_TYPES });
    expect(starterPageFiles("blank")).toEqual([]);
  });

  it("uses one definition per key across templates", () => {
    const seen = new Map<string, unknown>();
    for (const key of SPACE_TEMPLATE_KEYS) {
      const { properties, pageTypes } = SPACE_TEMPLATES[key];
      for (const definition of [...properties, ...pageTypes]) {
        const id = `${"type" in definition ? "property" : "type"}:${definition.key}`;
        if (seen.has(id)) expect(definition).toEqual(seen.get(id));
        seen.set(id, definition);
      }
    }
  });

  it("writes starter pages as overview pages", () => {
    expect(starterPageFiles("it")[0]).toEqual({
      slug: "software",
      markdown:
        "---\ntitle: Software\ndescription: The apps and systems we use.\ntype: overview\n---\n\n" +
        "Every app and system has a page here: what it is for, how to get access, and who helps.\n",
    });
  });

  it("adds only what a space doesn't have, and keeps what it has", () => {
    const ownPolicy = { key: "policy", label: "Rule", template: "", requiredProperties: [] };
    const { schema, added } = addTemplateSchema(
      {
        properties: [{ key: "systems", label: "Apps", type: "text", options: [], required: false, help: "" }],
        pageTypes: [ownPolicy],
      },
      "it",
    );
    expect(added.properties.map((property) => property.key)).toEqual(["audience"]);
    expect(added.pageTypes.map((pageType) => pageType.key)).toEqual([
      "overview",
      "how-to",
      "reference",
      "tool",
      "troubleshooting",
    ]);
    expect(schema.pageTypes[0]).toBe(ownPolicy);
    expect(schema.properties[0]!.label).toBe("Apps");
    expect(addTemplateSchema(schema, "it").added).toEqual({ properties: [], pageTypes: [] });
  });
});
