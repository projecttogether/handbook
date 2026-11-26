import { InputRule } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { AlertTriangle, FileCode, Info, Lightbulb, MessageSquareWarning, OctagonAlert } from "lucide-react";
import { CALLOUT_TYPES, type CalloutType } from "@/components/page/markdown-plugins";
import { useT } from "@/i18n";
import { richTextMessages } from "./messages";
import { Callout, RawMarkdown, isCalloutType } from "./schema";

const CALLOUT_ICONS: Record<CalloutType, typeof Info> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: AlertTriangle,
  caution: OctagonAlert,
};

/** A callout as on the page, with its type to choose. */
function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const t = useT(richTextMessages);
  const type: CalloutType = isCalloutType(node.attrs.type) ? node.attrs.type : "note";
  const Icon = CALLOUT_ICONS[type];
  return (
    <NodeViewWrapper data-callout={type} role="note">
      <div data-callout-title contentEditable={false}>
        <Icon className="size-[1.1em]" aria-hidden />
        {editor.isEditable ? (
          <select
            aria-label={t("calloutType")}
            value={type}
            onChange={(event) => updateAttributes({ type: event.target.value })}
            className="cursor-pointer appearance-none bg-transparent font-[inherit] tracking-[inherit] uppercase outline-none focus-visible:underline"
          >
            {CALLOUT_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </select>
        ) : (
          t(type)
        )}
      </div>
      <NodeViewContent data-callout-body="" />
    </NodeViewWrapper>
  );
}

/** Markdown the rich text cannot show, editable as text and saved exactly as written. */
function RawMarkdownView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const t = useT(richTextMessages);
  const source = String(node.attrs.source ?? "");
  return (
    <NodeViewWrapper
      contentEditable={false}
      data-raw-markdown=""
      data-selected={selected ? "" : undefined}
      className="border-border bg-muted/40 my-6 rounded-lg border border-dashed p-3 font-sans text-sm data-[selected]:ring-2 data-[selected]:ring-ring/50"
    >
      <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs">
        <FileCode className="size-3.5" aria-hidden />
        <span className="font-semibold">{t("rawTitle")}</span>
        <span>· {t("rawHelp")}</span>
      </p>
      <textarea
        aria-label={t("rawLabel")}
        value={source}
        readOnly={!editor.isEditable}
        spellCheck={false}
        rows={Math.min(Math.max(source.split("\n").length, 1), 20)}
        onChange={(event) => updateAttributes({ source: event.target.value })}
        className="w-full resize-y bg-transparent font-mono text-[0.8125rem] leading-6 outline-none"
      />
    </NodeViewWrapper>
  );
}

/** Callouts in the editor: shown with their type, and `[!TIP] ` typed in a quote turns it into one. */
export const EditorCallout = Callout.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\[!(note|tip|important|warning|caution)\]\s$/i,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          const depth = $from.depth - 1;
          if (depth < 1 || $from.node(depth).type.name !== "blockquote" || $from.index(depth) !== 0)
            return null;
          const type = state.schema.nodes.callout;
          if (!type) return null;
          state.tr.delete(range.from, range.to);
          state.tr.setNodeMarkup($from.before(depth), type, { type: match[1]!.toLowerCase() });
        },
      }),
    ];
  },
});

export const EditorRawMarkdown = RawMarkdown.extend({
  addNodeView() {
    return ReactNodeViewRenderer(RawMarkdownView, {
      // The text area handles its own typing and selection.
      stopEvent: ({ event }) => event.target instanceof HTMLTextAreaElement,
    });
  },
});
