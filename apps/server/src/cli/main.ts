import { ConfigError } from "../config";
import { AppError, databaseErrorCode } from "../http/errors";
import { UsageError, type CliIo } from "./io";
import { tokensCommand } from "./tokens";

const HELP = `Handbook: the operator command. On a server with compose.yaml:
  docker compose run --rm -T migrate cli <command>
In a terminal of the app's container: cli <command>

Commands:
  cli tokens create service --name <name> [--expires-in-days <days>|never]
                               a read-only service token (Administration > Service
                               tokens), alone on stdout, once; expires in 90 days
                               unless you say otherwise. Run it with
                               docker compose exec -T web cli …: Docker logs what
                               a container started with "run" prints
  cli tokens list [--json]     the service tokens, without their secrets
  cli tokens revoke <id>       end a service token for good
  cli help                     this text

Handbook's settings are in .env, so there is no "cli settings".
Exit codes: 0 done, 1 refused (the page's message on stderr), 2 wrong command.
Docs: https://github.com/projecttogether/handbook/blob/main/docs/deployment.md#service-tokens-from-the-command-line
`;

/** What went wrong, for stderr, and the exit code. */
function report(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.err(
      `${error.message}\n${error.usage ? `Usage: ${error.usage}\n` : ""}Run "cli help" for the commands.\n`,
    );
    return 2;
  }
  if (error instanceof AppError) {
    io.err(`${error.message}\n`);
    for (const [field, message] of Object.entries(error.fields ?? {})) io.err(`  ${field}: ${message}\n`);
    return 1;
  }
  if (error instanceof ConfigError) {
    io.err(`Missing or invalid variables: ${error.variables.join(", ")}\n`);
    return 1;
  }
  // The page's generic message with a code at most, such as 28P01 or
  // ECONNREFUSED: any other text can quote values, e.g. of a failed query.
  const code = databaseErrorCode(error);
  io.err(`Something went wrong. Try again.${code && /^[0-9A-Z_]+$/.test(code) ? ` (${code})` : ""}\n`);
  return 1;
}

/** Runs `cli <args>` and returns the exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        if (rest.length > 0) throw new UsageError("help takes no arguments.");
        io.out(HELP);
        return 0;
      case "tokens":
        await tokensCommand(rest, io);
        return 0;
      case undefined:
        io.err(HELP);
        return 2;
      default:
        throw new UsageError("Unknown command.");
    }
  } catch (error) {
    return report(error, io);
  }
}
