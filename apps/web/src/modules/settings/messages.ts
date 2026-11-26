import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Settings and agents",
    description: "Connect AI agents and apps to this knowledge base, and manage their access.",
    about: "Handbook is ProjectTogether's open-source knowledge base.",

    agentsTitle: "What agents may do",
    agentsText:
      "Agents act as you. They read every space and suggest changes as change sets, which editors review and merge. They never publish or merge on their own. Disconnect them here at any time.",

    connectTitle: "Connect an agent",
    connectDescription:
      "Agents connect through MCP, a standard way for AI tools to use apps. Use this address in the agent's settings.",
    mcpUrl: "MCP address",
    clientClaude: "Claude (browser, desktop, mobile)",
    clientClaudeText:
      "Settings → Connectors → Add custom connector. Paste the address and sign in when asked.",
    clientChatgpt: "ChatGPT",
    clientChatgptText:
      "Turn on developer mode, then add a connector with the address. Choose OAuth and sign in when asked.",
    clientLangdock: "Langdock",
    clientLangdockText:
      "Integrations → add a remote MCP server with the address. Sign in with OAuth, or use a personal token below as API key with the header type “Authorization: Bearer”.",
    clientClaudeCode: "Claude Code",
    clientClaudeCodeText: "Run this command. Claude Code asks you to sign in the first time it connects:",
    clientClaudeCodeToken: "Or with a personal token:",
    clientOther: "Codex and other clients",
    clientOtherText:
      "Add a remote (Streamable HTTP) MCP server with the address and the header “Authorization: Bearer <token>”, using a personal token below.",

    tokensTitle: "Personal tokens",
    tokensDescription:
      "For agents and scripts that cannot sign in themselves. A token acts as you, with the same limits as connected apps.",
    newToken: "New token",
    createTokenTitle: "New personal token",
    createTokenDescription: "The agent that uses it acts as you: it reads every space and suggests changes.",
    tokenNameHint: "Name it after the agent or script that uses it, e.g. “Claude Code on my laptop”.",
    tokenCreated: "Token created",
    noTokens: "No personal tokens.",
    colName: "Name",
    colToken: "Token",
    colCreated: "Created",
    colLastUsed: "Last used",
    colExpires: "Expires",
    never: "Never",
    notUsed: "Not used yet",
    revoke: "Revoke",
    revokeTitle: "Revoke “{name}”?",
    revokeDescription: "Agents and scripts that use it lose access at once.",
    revoked: "Token revoked",

    appsTitle: "Connected apps",
    appsDescription: "Apps you connected by signing in, such as Claude, ChatGPT or Langdock.",
    noApps: "No connected apps.",
    colApp: "App",
    colRedirect: "Returns to",
    colConnected: "Connected",
    disconnect: "Disconnect",
    disconnectTitle: "Disconnect “{name}”?",
    disconnectDescription: "The app loses access at once. You can connect it again later.",
    disconnected: "App disconnected",
  },
});
