import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Connect {app}?",
    description: "{app} wants to use {appName} as you.",
    mayTitle: "It may",
    mayRead: "Read every space and page.",
    mayPropose: "Suggest changes as change sets, which editors review and merge.",
    mayNot: "It cannot publish or merge changes, and it cannot change settings.",
    disconnect: "You can disconnect it any time in Settings.",
    identifiedBy: "Identified by",
    notVerified: "Not verified",
    returnsTo: "Returns to",
    registeredDynamic:
      "This app registered itself and chose its own name; nobody checked who made it. Connect only if you just started connecting it yourself.",
    registeredDocument: "The app's name comes from a description published at {host}.",
    approve: "Connect",
    deny: "Cancel",
    expiredTitle: "This sign-in request is no longer valid",
    expiredText: "It expired or was already used. Start connecting again from the app.",
    failed: "Something went wrong. Try again.",
    leaving: "Returning to the app…",
  },
});
