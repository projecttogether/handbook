import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { inlineFromMarkdown, parseBody, serializeBody } from "./markdown";
import { schemaExtensions } from "./schema";

const schema = getSchema(schemaExtensions());

const doc = (...content: JSONContent[]) => schema.nodeFromJSON({ type: "doc", content });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const text = (value: string, ...marks: string[]): JSONContent =>
  marks.length > 0
    ? { type: "text", text: value, marks: marks.map((type) => ({ type })) }
    : { type: "text", text: value };

/** Replaces the top-level block at `index` (a new node, as an edit makes). */
function replaceBlock(document: PMNode, index: number, block: JSONContent): PMNode {
  const children: PMNode[] = [];
  document.forEach((child, _, i) => children.push(i === index ? schema.nodeFromJSON(block) : child));
  return schema.node("doc", null, children);
}

const MESSY = [
  "Intro line one",
  "continues here with *stars* and __underscores__.",
  "Heading",
  "=======",
  "",
  "* star bullet",
  "* another",
  "",
  "+ plus list",
  "",
  "    indented code",
  "",
  "1) paren list",
  "2) second",
  "",
  "> [!WARNING]",
  "> Mind the gap.",
  "",
  "| a | b |",
  "|:--|--:|",
  "| 1 | 2",
  "",
  "<div>html block</div>",
  "",
  "A [reference link][ref] and a note[^1].",
  "",
  "[ref]: https://example.org",
  "[^1]: The note.",
  "",
  "- [ ] open task",
  "- [x] done task",
  "***",
  "Trailing paragraph without final newline",
].join("\n");

describe("parseBody and serializeBody", () => {
  it.each([
    ["an empty body", ""],
    ["a plain paragraph", "Hello.\n"],
    ["no final line break", "# Title\n\nText"],
    ["blank lines everywhere", "\n\n# Title\n\n\n\nText\n\n\n"],
    ["Markdown in many styles", MESSY],
    ["a heading right above its text", "## Steps\n1. First\n2. Second\n## Result\nDone.\n"],
    ["a template with empty items", "## Before you start\n\n- \n\n## Steps\n\n1. \n\n## Result\n"],
  ])("writes %s back unchanged when nothing changed", (_, body) => {
    const { doc: parsed, origin } = parseBody(body, schema);
    expect(serializeBody(parsed, origin)).toBe(body);
  });

  it("rewrites only the block that changed", () => {
    const body = "Intro with *stars*.\n\n* one\n* two\n\nOld text.\n\n|a|b|\n|-|-|\n|1|2|\n";
    const { doc: parsed, origin } = parseBody(body, schema);
    const edited = replaceBlock(parsed, 2, p(text("New "), text("bold", "bold"), text(" text.")));
    expect(serializeBody(edited, origin)).toBe(
      "Intro with *stars*.\n\n* one\n* two\n\nNew **bold** text.\n\n|a|b|\n|-|-|\n|1|2|\n",
    );
  });

  it("keeps the start number of a changed ordered list, also 0", () => {
    const body = "Steps:\n\n0. zero\n1. one\n";
    const { doc: parsed, origin } = parseBody(body, schema);
    const list = parsed.child(1).toJSON() as JSONContent;
    const item: JSONContent = { type: "listItem", content: [p(text("two"))] };
    const edited = replaceBlock(parsed, 1, { ...list, content: [...(list.content ?? []), item] });
    expect(serializeBody(edited, origin)).toBe("Steps:\n\n0. zero\n1. one\n2. two\n");
  });

  it("keeps blocks that only moved, and drops deleted ones", () => {
    const body = "First.\n\nSecond.\n\nThird.\n";
    const { doc: parsed, origin } = parseBody(body, schema);
    const children: PMNode[] = [parsed.child(2), parsed.child(0)];
    expect(serializeBody(schema.node("doc", null, children), origin)).toBe("Third.\n\nFirst.\n");
  });

  it("keeps Markdown the rich text cannot hold as raw blocks", () => {
    const { doc: parsed } = parseBody(MESSY, schema);
    const raw: string[] = [];
    parsed.forEach((child) => {
      if (child.type.name === "rawMarkdown") raw.push(String(child.attrs.source));
    });
    expect(raw).toEqual([
      "<div>html block</div>",
      "A [reference link][ref] and a note[^1].",
      "[ref]: https://example.org",
      "[^1]: The note.",
    ]);
  });

  it("reads callouts, tables, task lists and code blocks", () => {
    const { doc: parsed } = parseBody(
      "> [!TIP]\n> Ask early.\n\n| Name | Role |\n| :--- | ---: |\n| Ada | Admin |\n\n- [x] Done\n\n```sh\nnpm ci\n```\n",
      schema,
    );
    expect(parsed.toJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "callout",
          attrs: { type: "tip" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Ask early." }] }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                expect.objectContaining({
                  type: "tableHeader",
                  attrs: expect.objectContaining({ align: "left" }),
                }),
                expect.objectContaining({
                  type: "tableHeader",
                  attrs: expect.objectContaining({ align: "right" }),
                }),
              ],
            },
            expect.objectContaining({ type: "tableRow" }),
          ],
        },
        {
          type: "taskList",
          attrs: { spread: false },
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "sh", meta: null },
          content: [{ type: "text", text: "npm ci" }],
        },
      ],
    });
  });

  it("writes new content in the app's Markdown style", () => {
    const written = doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Steps")] },
      p(
        text("Use "),
        text("bold", "bold"),
        text(", "),
        text("italic", "italic"),
        text(", "),
        text("gone", "strike"),
        text(" and "),
        text("code", "code"),
        text("."),
      ),
      p({
        type: "text",
        text: "npm ci",
        marks: [{ type: "link", attrs: { href: "/s/it/setup" } }, { type: "code" }],
      }),
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [
          { type: "listItem", content: [p(text("Three"))] },
          { type: "listItem", content: [p(text("Four"))] },
        ],
      },
      {
        type: "taskList",
        content: [{ type: "taskItem", attrs: { checked: false }, content: [p(text("Ask"))] }],
      },
      { type: "callout", attrs: { type: "warning" }, content: [p(text("Careful."))] },
      { type: "codeBlock", attrs: { language: "sh" }, content: [text("npm ci")] },
      p(text("Line one"), { type: "hardBreak" }, text("line two "), {
        type: "image",
        attrs: { src: "/files/1/a.png", alt: "Screen" },
      }),
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", attrs: { align: "left" }, content: [p(text("Name"))] },
              { type: "tableHeader", content: [p(text("Notes"))] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [p(text("Ada"))] },
              { type: "tableCell", content: [p(text("a | b"))] },
            ],
          },
        ],
      },
      { type: "horizontalRule" },
    );
    expect(serializeBody(written, null)).toBe(
      [
        "## Steps",
        "",
        "Use **bold**, _italic_, ~~gone~~ and `code`.",
        "",
        "[`npm ci`](/s/it/setup)",
        "",
        "3. Three",
        "4. Four",
        "",
        "- [ ] Ask",
        "",
        "> [!WARNING]",
        "> Careful.",
        "",
        "```sh",
        "npm ci",
        "```",
        "",
        "Line one\\",
        "line two ![Screen](/files/1/a.png)",
        "",
        "| Name | Notes  |",
        "| :--- | ------ |",
        "| Ada  | a \\| b |",
        "",
        "---",
        "",
      ].join("\n"),
    );
  });

  it("reads what it writes", () => {
    const written = doc(
      { type: "callout", attrs: { type: "note" }, content: [p(text("A "), text("note", "bold"))] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              p(text("Outer")),
              { type: "bulletList", content: [{ type: "listItem", content: [p(text("Inner"))] }] },
            ],
          },
        ],
      },
      p(text("a*b_c [x] <y> # z")),
    );
    const markdown = serializeBody(written, null);
    const { doc: again } = parseBody(markdown, schema);
    expect(again.toJSON()).toEqual(written.toJSON());
  });

  it("moves spaces out of bold text", () => {
    expect(serializeBody(doc(p(text("A"), text(" bold ", "bold"), text("word"))), null)).toBe(
      "A **bold** word\n",
    );
  });

  it("keeps two neighboring lists apart", () => {
    const list: JSONContent = {
      type: "bulletList",
      content: [{ type: "listItem", content: [p(text("Item"))] }],
    };
    expect(serializeBody(doc(list, list), null)).toBe("- Item\n\n* Item\n");
    // Both unchanged: a separator, so neither list is rewritten (numbers, spacing, emphasis).
    const { doc: parsed, origin } = parseBody("1) One\n\nText\n\n3)   *Two*\n7)   Next\n", schema);
    const children: PMNode[] = [parsed.child(0), parsed.child(2)];
    expect(serializeBody(schema.node("doc", null, children), origin)).toBe(
      "1) One\n\n<!-- -->\n\n3)   *Two*\n7)   Next\n",
    );
  });

  it("keeps each unchanged block's own source when two blocks look the same", () => {
    const { doc: parsed, origin } = parseBody("*same*\n\n_same_\n", schema);
    const children: PMNode[] = [parsed.child(1)];
    expect(serializeBody(schema.node("doc", null, children), origin)).toBe("_same_\n");
  });

  it("does not let a new look-alike block take an unchanged block's source", () => {
    const { doc: parsed, origin } = parseBody("*same*\n\n_same_\n", schema);
    const children: PMNode[] = [
      schema.nodeFromJSON(p(text("same", "italic"))),
      parsed.child(0),
      parsed.child(1),
    ];
    expect(serializeBody(schema.node("doc", null, children), origin)).toBe("_same_\n\n*same*\n\n_same_\n");
  });

  it("closes a code block left open at the end when something now follows it", () => {
    const { doc: parsed, origin } = parseBody("Intro.\n\n```sh\nnpm ci\n", schema);
    const children: PMNode[] = [parsed.child(0), parsed.child(1), schema.nodeFromJSON(p(text("After.")))];
    const written = serializeBody(schema.node("doc", null, children), origin);
    expect(written).toBe("Intro.\n\n```sh\nnpm ci\n```\n\nAfter.\n");
    expect(parseBody(written, schema).doc.childCount).toBe(3);
  });

  it("tells an open fence from code that only contains fences", () => {
    // Indented code that starts with backticks is no fence: kept as written.
    const indented = parseBody("Para.\n\n    ```\n    literal\n\nLast.\n", schema);
    expect(serializeBody(replaceBlock(indented.doc, 2, p(text("Last!"))), indented.origin)).toBe(
      "Para.\n\n    ```\n    literal\n\nLast!\n",
    );
    // A line of 4 spaces and backticks does not close a fence, and any character but a line break
    // may be in the info string: still open, so a closing fence is added.
    for (const [body, expected] of [
      ["Intro.\n\n```\ncode\n    ```", "Intro.\n\n```\ncode\n    ```\n```\n\nAfter.\n"],
      ["Intro.\n\n```a\u2028b\ncode", "Intro.\n\n```a\u2028b\ncode\n```\n\nAfter.\n"],
    ]) {
      const open = parseBody(body!, schema);
      const children: PMNode[] = [
        open.doc.child(0),
        open.doc.child(1),
        schema.nodeFromJSON(p(text("After."))),
      ];
      const written = serializeBody(schema.node("doc", null, children), open.origin);
      expect(written).toBe(expected);
      const reread: string[] = [];
      parseBody(written, schema).doc.forEach((node) => reread.push(node.type.name));
      expect(reread).toEqual(["paragraph", "codeBlock", "paragraph"]);
    }
  });

  it("keeps the indentation of a block after a changed one", () => {
    const body = "Intro.\n\n  ```\n  code\n    more\n  ```\n";
    const { doc: parsed, origin } = parseBody(body, schema);
    const edited = replaceBlock(parsed, 0, p(text("New intro.")));
    expect(serializeBody(edited, origin)).toBe("New intro.\n\n  ```\n  code\n    more\n  ```\n");
  });

  it("gives a changed list other markers than the unchanged list beside it", () => {
    const { doc: parsed, origin } = parseBody("* One\n\n- Two\n", schema);
    const edited = replaceBlock(parsed, 0, {
      type: "bulletList",
      content: [{ type: "listItem", content: [p(text("One!"))] }],
    });
    expect(serializeBody(edited, origin)).toBe("* One!\n\n- Two\n");
  });

  it("separates a new list from neighbors that use both ordered markers", () => {
    const { doc: parsed, origin } = parseBody("1) Left\n\nText\n\n1. Right\n", schema);
    const edited = replaceBlock(parsed, 1, {
      type: "orderedList",
      content: [{ type: "listItem", content: [p(text("Edited"))] }],
    });
    const written = serializeBody(edited, origin);
    expect(written).toBe("1) Left\n\n1. Edited\n\n<!-- -->\n\n1. Right\n");
    const lists: string[] = [];
    parseBody(written, schema).doc.forEach((node) => lists.push(node.type.name));
    expect(lists).toEqual(["orderedList", "orderedList", "rawMarkdown", "orderedList"]);
  });

  it("gives the inline content of an uploaded file's Markdown", () => {
    expect(inlineFromMarkdown("![Plan](/files/7/plan.png)", schema)).toEqual([
      {
        type: "image",
        attrs: { src: "/files/7/plan.png", alt: "Plan", title: null, width: null, height: null },
      },
    ]);
  });
});
