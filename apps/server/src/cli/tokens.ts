import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { idSchema } from "@handbook/shared/api/common";
import { tokenCreateSchema } from "@handbook/shared/api/tokens";
import { operator } from "../auth/principal";
import { createServiceToken, listServiceTokens, revokeServiceToken } from "../auth/service-tokens";
import { getDb } from "../db/client";
import { parseWith } from "../http/errors";
import { UsageError, type CliIo } from "./io";

/*
 * `cli tokens …`: the service tokens of Administration > Service tokens. A
 * new one goes to stdout alone, once, so that `> file` keeps only the token;
 * notes go to stderr.
 */

const CREATE_USAGE = "cli tokens create service --name <name> [--expires-in-days <days>|never]";
const LIST_USAGE = "cli tokens list [--json]";
const REVOKE_USAGE = "cli tokens revoke <id>";

/** The options of a command; anything else is a wrong command. */
function parse(args: string[], options: ParseArgsOptionsConfig, usage: string) {
  try {
    return parseArgs({ args, options }).values;
  } catch {
    // The parser's message quotes the argument, which could be a secret.
    throw new UsageError("An argument is unknown or has no value (not shown).", usage);
  }
}

const day = (value: string | null) => value?.slice(0, 10) ?? "never";

async function create(args: string[], io: CliIo) {
  const [kind, ...rest] = args;
  if (kind !== "service")
    throw new UsageError("Name a kind of token. The only one is service.", CREATE_USAGE);
  const values = parse(
    rest,
    { name: { type: "string" }, "expires-in-days": { type: "string" } },
    CREATE_USAGE,
  );
  if (values.name === undefined) {
    throw new UsageError("Name the token with --name, e.g. after the app that uses it.", CREATE_USAGE);
  }
  const days = values["expires-in-days"] as string | undefined;
  if (days !== undefined && !/^(\d{1,9}|never)$/.test(days)) {
    throw new UsageError("--expires-in-days takes a number of days or never.", CREATE_USAGE);
  }
  const input = parseWith(tokenCreateSchema, {
    name: values.name,
    // Left out: the API's default.
    ...(days === undefined ? {} : { expiresInDays: days === "never" ? null : Number(days) }),
  });
  const created = await createServiceToken(getDb(), operator("cli tokens create service"), input);
  io.out(`${created.secret}\n`);
  io.err(`Created. ID: ${created.id}, expires: ${day(created.expiresAt)}\n`);
}

async function list(args: string[], io: CliIo) {
  const values = parse(args, { json: { type: "boolean" } }, LIST_USAGE);
  const tokens = await listServiceTokens(getDb());
  if (values.json) {
    io.out(`${JSON.stringify(tokens, null, 2)}\n`);
    return;
  }
  if (tokens.length === 0) io.out("No service tokens.\n");
  for (const token of tokens) {
    const state = token.expiresAt && Date.parse(token.expiresAt) <= Date.now() ? "expired" : "active";
    const hints = [
      // As JSON: one line, also with a name that has line breaks or control characters.
      JSON.stringify(token.name),
      token.prefix,
      `created ${day(token.createdAt)}${token.createdBy ? ` by ${token.createdBy}` : ""}`,
      `last used ${day(token.lastUsedAt)}`,
      `expires ${day(token.expiresAt)}`,
    ];
    io.out(`service ${token.id}  ${state.padEnd(7)}  ${hints.join("; ")}\n`);
  }
}

async function revoke(args: string[], io: CliIo) {
  const [value, ...rest] = args;
  parse(rest, {}, REVOKE_USAGE);
  const id = idSchema.safeParse(value);
  if (!id.success) throw new UsageError("Give the token's ID, as cli tokens list shows it.", REVOKE_USAGE);
  await revokeServiceToken(getDb(), operator("cli tokens revoke"), id.data);
  io.err("Revoked.\n");
}

/** `cli tokens …` */
export async function tokensCommand(args: string[], io: CliIo): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "create":
      return create(rest, io);
    case "list":
      return list(rest, io);
    case "revoke":
      return revoke(rest, io);
    default:
      throw new UsageError("Unknown command.", "cli tokens create|list|revoke");
  }
}
