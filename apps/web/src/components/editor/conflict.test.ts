import { describe, expect, it } from "vitest";
import { applyConflict, readPageConflict, saveBlocker } from "./conflict";

const body = {
  error: { code: "page_changed", message: "Someone else changed this page." },
  current: {
    revision: 7,
    markdown: "---\ntitle: A\n---\n\nTheirs\n",
    updatedBy: { id: null, name: "Kim", email: null },
  },
  merged: "---\ntitle: A\n---\n\n<<<<<<< yours\nMine\n=======\nTheirs\n>>>>>>> current\n",
  conflicts: 1,
};

describe("save conflicts", () => {
  it("reads a page_changed answer", () => {
    expect(readPageConflict(body)).toEqual({
      currentRevision: 7,
      merged: body.merged,
      conflicts: 1,
      updatedBy: "Kim",
    });
    expect(readPageConflict({ error: { code: "page_locked" } })).toBeNull();
    expect(readPageConflict(null)).toBeNull();
  });

  it("continues from the current revision with the merged text, and blocks saving until resolved", () => {
    const conflict = readPageConflict(body)!;
    const next = applyConflict({ file: "mine", baseRevision: 5, conflict: null }, conflict);
    expect(next.baseRevision).toBe(7);
    expect(next.file).toBe(body.merged);
    expect(saveBlocker(next.file)).toBe("conflict_markers");
    expect(saveBlocker("---\ntitle: A\n---\n\nMine and theirs\n")).toBeNull();
  });
});
