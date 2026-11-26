import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "@handbook/shared/api/search";
import { highlightParts } from "./search-page";

describe("search snippets", () => {
  it("marks the matched words", () => {
    const snippet = `Connect the ${HIGHLIGHT_START}laptop${HIGHLIGHT_END} to the ${HIGHLIGHT_START}VPN${HIGHLIGHT_END}.`;
    const { container } = render(<p>{highlightParts(snippet)}</p>);
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "laptop",
      "VPN",
    ]);
    expect(container.textContent).toBe("Connect the laptop to the VPN.");
  });

  it("keeps text without marks and survives a missing end mark", () => {
    expect(highlightParts("plain")).toEqual(["plain"]);
    const { container } = render(<p>{highlightParts(`a ${HIGHLIGHT_START}b`)}</p>);
    expect(container.querySelector("mark")?.textContent).toBe("b");
  });
});
