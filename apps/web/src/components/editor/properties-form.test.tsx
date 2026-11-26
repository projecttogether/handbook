import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SpaceSchema } from "@handbook/shared/page";
import { valuesOf, withValues } from "./file";
import { PropertiesForm } from "./properties-form";

const schema: SpaceSchema = {
  properties: [
    { key: "team", label: "Team", type: "select", options: ["it", "hr"], required: false, help: "" },
    { key: "systems", label: "Systems", type: "list", options: [], required: false, help: "" },
  ],
  pageTypes: [],
};

/** The form wired to a file, as the editor does it. */
function Harness(props: {
  initial: string;
  onFile: (file: string) => void;
  errors?: Record<string, string>;
}) {
  const [file, setFile] = useState(props.initial);
  const read = valuesOf(file);
  return (
    <PropertiesForm
      values={"values" in read ? read.values : {}}
      schema={schema}
      errors={props.errors}
      onChange={(values) => {
        const next = withValues(file, values, schema);
        setFile(next);
        props.onFile(next);
      }}
    />
  );
}

describe("PropertiesForm", () => {
  it("writes typed values into the frontmatter and keeps the body", async () => {
    const files: string[] = [];
    render(<Harness initial={"---\ntitle: VPN\n---\n\nBody\n"} onFile={(file) => files.push(file)} />);
    const title = screen.getByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, "VPN access");
    await userEvent.type(screen.getByLabelText("Tags"), "Network, remote");
    await userEvent.type(screen.getByLabelText("Systems"), "Firewall{enter}Laptop");
    expect(files.at(-1)).toBe(
      "---\ntitle: VPN access\ntags:\n  - Network\n  - remote\nsystems:\n  - Firewall\n  - Laptop\n---\n\nBody\n",
    );
    // What the person typed stays as typed, including the separator.
    expect(screen.getByLabelText("Tags")).toHaveValue("Network, remote");
  });

  it("shows errors and offers to remove properties the space does not define", async () => {
    const files: string[] = [];
    render(
      <Harness
        initial={"---\ntitle: VPN\ncolor: red\n---\n"}
        errors={{ title: "Add a title" }}
        onFile={(file) => files.push(file)}
      />,
    );
    expect(screen.getByText("Add a title")).toBeInTheDocument();
    expect(screen.getByText("color: red")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove color" }));
    expect(files.at(-1)).toBe("---\ntitle: VPN\n---\n");
  });
});
