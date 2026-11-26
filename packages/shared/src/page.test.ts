import { describe, expect, it } from "vitest";
import {
  canonicalPageFile,
  normalizeBody,
  parsePageFile,
  readFrontmatterValues,
  spaceSchemaProblems,
  splitFrontmatter,
  validateFrontmatter,
  withFrontmatter,
  type SpaceSchema,
} from "./page";

const schema: SpaceSchema = {
  properties: [
    { key: "team", label: "Team", type: "select", options: ["it", "hr"], required: false, help: "" },
    { key: "systems", label: "Systems", type: "list", options: [], required: false, help: "" },
    { key: "reviewed_on", label: "Reviewed", type: "date", options: [], required: false, help: "" },
  ],
  pageTypes: [{ key: "workflow", label: "Workflow", template: "", requiredProperties: ["team"] }],
};

describe("page files", () => {
  it("writes one canonical form", () => {
    const result = canonicalPageFile(
      "\uFEFF---\r\nsystems: Google\r\nstatus: active\r\ntitle: Email\r\ntags: [Mail , mail]\r\n---\r\n\r\nBody  \r\n\r\n\r\n",
      schema,
    );
    expect(result.ok && result.markdown).toBe(
      "---\ntitle: Email\ntags:\n  - mail\nsystems:\n  - Google\n---\n\nBody\n",
    );
  });

  it("names unknown and invalid properties", () => {
    const result = validateFrontmatter(
      { title: "", color: "red", team: "sales", reviewed_on: "2026-02-30" },
      schema,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toMatchObject({
      "properties.title": "Add a title",
      "properties.color": expect.stringContaining("Unknown property"),
      "properties.team": "Use one of: it, hr",
      "properties.reviewed_on": "Use a date like 2026-11-17",
    });
  });

  it("checks required properties of page types", () => {
    const result = validateFrontmatter({ title: "A", type: "workflow" }, schema);
    expect(!result.ok && result.errors["properties.team"]).toContain("Workflow");
  });

  it("lets page types require built-in properties", () => {
    const withPolicy: SpaceSchema = {
      properties: [],
      pageTypes: [
        { key: "policy", label: "Policy", template: "", requiredProperties: ["owner", "reviewed"] },
      ],
    };
    expect(spaceSchemaProblems(withPolicy)).toEqual({});
    const missing = validateFrontmatter({ title: "A", type: "policy", owner: "not an address" }, withPolicy);
    expect(!missing.ok && missing.errors).toEqual({
      "properties.owner": "Use an email address",
      "properties.reviewed": "Pages of type “Policy” need “Last reviewed”",
    });
    expect(
      validateFrontmatter(
        { title: "A", type: "policy", owner: "ada@example.org", reviewed: "2026-11-19" },
        withPolicy,
      ).ok,
    ).toBe(true);
    // Only built-in properties that can be missing.
    expect(
      spaceSchemaProblems({
        ...withPolicy,
        pageTypes: [{ ...withPolicy.pageTypes[0]!, requiredProperties: ["title"] }],
      }),
    ).toEqual({ "pageTypes.0.requiredProperties": "Unknown property “title”" });
  });

  it("refuses files without frontmatter and YAML that is not a mapping", () => {
    expect(parsePageFile("# Title", schema).ok).toBe(false);
    expect(parsePageFile("---\n- a\n---\n", schema).ok).toBe(false);
    expect(parsePageFile("---\ntitle: [unclosed\n---\n", schema).ok).toBe(false);
  });

  it("ends the frontmatter only at a line of three dashes, not at a value that ends in them", () => {
    const result = canonicalPageFile("---\ntitle: Plans ---\ntags: [roadmap]\n---\n\nText\n", schema);
    expect(result.ok && result.page.frontmatter).toMatchObject({ title: "Plans ---", tags: ["roadmap"] });
    expect(result.ok && result.page.body).toBe("Text\n");
    // Empty frontmatter ends at once: a rule in the body is not its end.
    expect(splitFrontmatter("---\n---\n\n---\nbody")).toEqual({ yaml: "", body: "\n---\nbody" });
    expect(parsePageFile("---\ntitle: A\n---", schema).ok).toBe(true);
  });

  it("replaces frontmatter and keeps the body", () => {
    expect(withFrontmatter("---\ntitle: A\n---\n\nText\n", { title: "B", tags: [] })).toBe(
      "---\ntitle: B\n---\n\nText\n",
    );
  });

  it("refuses Markdown the parser cannot handle, naming the line of the file", () => {
    const result = parsePageFile(`---\ntitle: A\n---\n\nText\n\n${"> ".repeat(20)}deep\n`, schema);
    expect(result).toEqual({
      ok: false,
      errors: { markdown: "Line 7: lists, quotes and footnotes are nested more than 16 levels deep" },
    });
  });

  it("refuses duplicate keys and YAML aliases", () => {
    expect(readFrontmatterValues("title: A\ntitle: B\n")).toEqual({
      error: "The frontmatter is not valid YAML: Map keys must be unique",
    });
    expect(readFrontmatterValues("title: &name A\ndescription: *name\n")).toEqual({
      error: "The frontmatter is not valid YAML: aliases (*name) are not supported",
    });
  });
});

/** Milliseconds a call takes. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("page files near the size limit", () => {
  it("trims the end of the body in time", () => {
    expect(normalizeBody("\n\nBody  \n\n\t\n")).toBe("Body\n");
    const body = `a${" ".repeat(480_000)}b`;
    expect(timed(() => expect(normalizeBody(body)).toBe(`${body}\n`))).toBeLessThan(1500);
  });

  it("checks long email addresses in time", () => {
    const owner = `a@${"a.".repeat(200_000)}@`;
    let result: ReturnType<typeof validateFrontmatter> | undefined;
    expect(timed(() => (result = validateFrontmatter({ title: "A", owner }, schema)))).toBeLessThan(1500);
    expect(result).toEqual({ ok: false, errors: { "properties.owner": "Use an email address" } });
  });

  it("reads frontmatter with many keys in time", () => {
    const yaml = Array.from({ length: 45_000 }, (_, index) => `key${index}: value`).join("\n");
    expect(timed(() => expect("values" in readFrontmatterValues(yaml)).toBe(true))).toBeLessThan(1500);
  });
});
