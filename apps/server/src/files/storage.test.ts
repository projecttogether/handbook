import { describe, expect, it } from "vitest";
import { mentionedFileIds } from "./storage";

describe("file mentions", () => {
  it("finds upload ids in links, absolute URLs and any case", () => {
    const id = "0b6f3a52-6f1c-4b8e-9d3a-2f6c1e7a9b10";
    const other = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    expect(
      mentionedFileIds([
        `![Screen](/files/${id}/screen%20shot.png) and [again](/files/${id}/x)`,
        null,
        `See https://handbook.example.org/files/${other.toUpperCase()}/plan.pdf`,
        "No files here; /files/not-an-id/x",
      ]),
    ).toEqual([id, other]);
  });
});
