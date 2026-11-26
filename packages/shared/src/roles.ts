import { z } from "zod";

/**
 * Who may do what (docs/identity-and-access.md):
 *
 * - Everyone signed in reads every space, and suggests changes as change sets.
 * - Space editors edit pages live, and review, merge and revert change sets.
 * - Space owners also choose the editors and set up the space.
 * - Admins create spaces, choose owners, and may do everything in every space.
 * - AI agents (personal tokens, connected apps) read everything and write
 *   only into change sets; they never edit live and never merge.
 * - Service tokens only read.
 */
export const SPACE_ROLES = ["owner", "editor"] as const;
export const spaceRoleSchema = z.enum(SPACE_ROLES);
export type SpaceRole = z.infer<typeof spaceRoleSchema>;

/** How a request authenticated. */
export const CHANNELS = ["web", "token", "oauth", "service"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Through which way a change was made; shown in histories. */
export const VIAS = ["web", "api", "mcp", "merge", "revert", "restore"] as const;
export const viaSchema = z.enum(VIAS);
export type Via = z.infer<typeof viaSchema>;

export type Abilities = {
  /** Edit pages live (create, edit, move, delete, restore). */
  editLive: boolean;
  /** Merge, revert and request changes on change sets. */
  review: boolean;
  /** Settings, members, properties and page types of the space (owners). */
  manage: boolean;
  /** Choose the space's owners (admins only). */
  manageOwners: boolean;
  /** Create and change change sets (suggestions). */
  propose: boolean;
  /** See draft pages. */
  seeDrafts: boolean;
};

/**
 * What a principal may do in a space.
 * `agent`: requests from AI agents (tokens, connected apps) only propose.
 */
export function spaceAbilities(input: {
  isAdmin: boolean;
  role: SpaceRole | null;
  agent: boolean;
  readOnly: boolean;
  archived?: boolean;
}): Abilities {
  if (input.readOnly) {
    return {
      editLive: false,
      review: false,
      manage: false,
      manageOwners: false,
      propose: false,
      seeDrafts: false,
    };
  }
  const editor = input.isAdmin || input.role === "owner" || input.role === "editor";
  const owner = input.isAdmin || input.role === "owner";
  const archived = input.archived ?? false;
  return {
    editLive: editor && !input.agent && !archived,
    review: editor && !input.agent && !archived,
    manage: owner && !input.agent,
    manageOwners: input.isAdmin && !input.agent,
    propose: !archived,
    seeDrafts: editor,
  };
}
