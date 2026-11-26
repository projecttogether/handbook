/** What a command writes; tests pass their own. */
export type CliIo = {
  /** The command's output: lines, JSON, or a new token alone. */
  out(text: string): void;
  /** Messages for the person at the terminal. */
  err(text: string): void;
};

/** A wrong command or option: exit code 2. Its message never repeats what was typed. */
export class UsageError extends Error {
  override name = "UsageError";
  constructor(
    message: string,
    /** The command's syntax, printed after the message. */
    readonly usage?: string,
  ) {
    super(message);
  }
}
