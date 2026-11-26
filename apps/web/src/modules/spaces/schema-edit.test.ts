import { describe, expect, it } from "vitest";
import { keyFromLabel, moved, propertyDefinitions, propertyRows, rowErrors } from "./schema-edit";

describe("space schema editing", () => {
  it("round-trips property definitions and keeps options only for choices", () => {
    const rows = propertyRows([
      { key: "team", label: "Team", type: "select", options: ["it", "hr"], required: true, help: "" },
      { key: "notes", label: "Notes", type: "text", options: [], required: false, help: "x" },
    ]);
    expect(rows[0]!.optionsText).toBe("it, hr");
    rows[1]!.optionsText = "ignored";
    expect(propertyDefinitions(rows)).toEqual([
      { key: "team", label: "Team", type: "select", options: ["it", "hr"], required: true, help: "" },
      { key: "notes", label: "Notes", type: "text", options: [], required: false, help: "x" },
    ]);
  });

  it("makes keys from labels", () => {
    expect(keyFromLabel("Review date", "_")).toBe("review_date");
    expect(keyFromLabel("Troubleshooting guide", "-")).toBe("troubleshooting-guide");
    expect(keyFromLabel("2nd Größe", "_")).toBe("nd_groesse");
  });

  it("maps field errors to rows", () => {
    expect(
      rowErrors({ "properties.1.key": "Taken", "properties.1.label": "Add", name: "x" }, "properties"),
    ).toEqual({
      1: { key: "Taken", label: "Add" },
    });
  });

  it("moves rows", () => {
    expect(moved(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});
