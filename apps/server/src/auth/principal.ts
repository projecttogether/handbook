import type { Channel } from "@handbook/shared/roles";

/** A person, signed in through the web app or acting through an agent's credential. */
export type UserPrincipal = {
  kind: "user";
  id: string;
  email: string;
  name: string;
  image: string | null;
  isAdmin: boolean;
  /** web (session cookie), token (personal access token) or oauth (connected app). */
  channel: Exclude<Channel, "service">;
  /**
   * True for agents (personal tokens and connected apps): they read
   * everything and write only into change sets.
   */
  agent: boolean;
  /** The token's name or the connected app's name, e.g. "Claude". */
  clientName: string | null;
  /** The credential used, for last-use times and audit. */
  credentialId: string | null;
};

/** A read-only service token (integrations such as a support bot). */
export type ServicePrincipal = {
  kind: "service";
  credentialId: string;
  name: string;
};

export type Principal = UserPrincipal | ServicePrincipal;

const OPERATOR = Symbol("operator");

/**
 * Whoever runs the operator command (`cli tokens …`) on the server, with an
 * admin's rights. Only the command creates one (src/cli): a request carries
 * no symbol, so no route can stand for it.
 */
export type OperatorPrincipal = {
  readonly [OPERATOR]: true;
  /** The command without its options, e.g. `cli tokens create service`, for the audit log. */
  readonly command: string;
};

/** Who administers something: an admin in the web app or the operator command. */
export type Actor = UserPrincipal | OperatorPrincipal;

/** The operator running `command`. Command line only. */
export function operator(command: string): OperatorPrincipal {
  return { [OPERATOR]: true, command };
}

export function isOperator(actor: unknown): actor is OperatorPrincipal {
  return typeof actor === "object" && actor !== null && OPERATOR in actor;
}

/** A short name for histories: "Ada Lovelace" or "Ada Lovelace via Claude". */
export function principalLabel(principal: Principal): string {
  if (principal.kind === "service") return principal.name;
  const name = principal.name || principal.email;
  return principal.clientName ? `${name} via ${principal.clientName}` : name;
}
