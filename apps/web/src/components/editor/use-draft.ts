import { useEffect, useRef, useState } from "react";
import { DRAFT_SAVE_SECONDS } from "@handbook/shared/limits";
import { rawRequest } from "./raw-api";

/**
 * Keeps the live editor's unsaved text on the server as the person's draft
 * of the page, every DRAFT_SAVE_SECONDS while it differs from what was
 * saved (docs/architecture.md, "Edit locks and drafts").
 */
export function useDraftAutosave(input: {
  pageId: string;
  file: string;
  baseRevision: number;
  /** The file as last saved to the page; no draft while they match. */
  savedFile: string;
  enabled: boolean;
}) {
  const latest = useRef(input);
  latest.current = input;
  const stored = useRef<string | null>(null);
  const [saved, setSaved] = useState<{ file: string; at: string } | null>(null);

  useEffect(() => {
    if (!input.enabled) return;
    const timer = window.setInterval(() => {
      const { pageId, file, baseRevision, savedFile } = latest.current;
      if (file === savedFile || file === stored.current) return;
      stored.current = file;
      void rawRequest("PUT", `/pages/${pageId}/draft`, { body: { markdown: file, baseRevision } }).then(
        (response) => {
          if (!response.ok) stored.current = null;
          else setSaved({ file, at: new Date().toISOString() });
        },
        () => {
          stored.current = null;
        },
      );
    }, DRAFT_SAVE_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [input.enabled, input.pageId]);
  /** When the draft was last stored, while the text still differs from the page. */
  return {
    savedAt: saved && saved.file === input.file && input.file !== input.savedFile ? saved.at : null,
  };
}

/** Removes the person's draft of a page (after saving or discarding). */
export function discardDraft(pageId: string) {
  return rawRequest("DELETE", `/pages/${pageId}/draft`).catch(() => undefined);
}
