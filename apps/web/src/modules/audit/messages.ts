import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Audit log",
    description:
      "Who created or archived spaces, chose owners and editors, changed admins or blocked people, and created or revoked tokens. Page changes are in each page's history. Entries never contain secrets.",
    empty: "No entries yet",
    emptyHint: "Changes by admins and owners appear here as they happen.",
    colWhen: "When",
    colWho: "Who",
    colWhat: "What",
    system: "System",
  },
});
