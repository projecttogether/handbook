import { describe, expect, it } from "vitest";
import type { SpaceSchema } from "@handbook/shared/page";
import { bodyOf, joinFile, splitFile, valuesOf, withBody, withValues } from "./file";

const schema: SpaceSchema = {
  properties: [{ key: "team", label: "Team", type: "text", options: [], required: false, help: "" }],
  pageTypes: [],
};

describe("editor file helpers", () => {
  const file = "---\ntitle: VPN\ntags:\n  - network\n---\n\nIntro  \n\n## Setup\n";

  it("splits and joins without changing the file", () => {
    const parts = splitFile(file);
    expect(parts.yaml).toBe("title: VPN\ntags:\n  - network");
    expect(joinFile(parts.yaml, parts.body)).toBe(file);
  });

  it("edits the body and keeps the frontmatter text", () => {
    expect(bodyOf(file)).toBe("Intro  \n\n## Setup\n");
    expect(withBody(file, "New text\n")).toBe("---\ntitle: VPN\ntags:\n  - network\n---\n\nNew text\n");
    expect(withBody(file, "")).toBe("---\ntitle: VPN\ntags:\n  - network\n---\n");
  });

  it("edits the frontmatter and keeps the body exactly", () => {
    const values = valuesOf(file);
    expect(values).toEqual({ values: { title: "VPN", tags: ["network"] } });
    const next = withValues(file, { team: "it", tags: [], title: "VPN access", description: "" }, schema);
    expect(next).toBe("---\ntitle: VPN access\nteam: it\n---\n\nIntro  \n\n## Setup\n");
  });

  it("reports frontmatter that cannot be read", () => {
    expect("error" in valuesOf("---\ntitle: [x\n---\n")).toBe(true);
    expect(valuesOf("no frontmatter")).toEqual({ values: {} });
  });
});
