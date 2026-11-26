/**
 * Spaces and pages are addressed by paths:
 *
 *   /s/<space>/<page path>        a page in the web app, e.g. /s/it/onboarding/laptop
 *   /s/<space>/<page path>.md     the same page as a Markdown file
 *
 * A page path is one or more slugs joined by "/": each sub-page adds its slug
 * to its parent's path. Links between pages are ordinary Markdown links,
 * either to `/s/<space>/<path>` or relative, as between files in a folder:
 * from `onboarding/laptop`, `vpn` means `onboarding/vpn` and `../policies`
 * means `policies`. A `.md` ending and a trailing `/index` are ignored.
 */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 80;
export const MAX_SPACE_SLUG_LENGTH = 40;
export const MAX_PATH_DEPTH = 10;
export const MAX_PATH_LENGTH = 400;

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug);
}

export function isValidSpaceSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SPACE_SLUG_LENGTH && SPACE_SLUG_PATTERN.test(slug);
}

/** True for a valid page path: 1 to 10 slugs joined by "/". */
export function isValidPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  const segments = path.split("/");
  return segments.length <= MAX_PATH_DEPTH && segments.every(isValidSlug);
}

/** Why a path is invalid, in words for people; null when valid. */
export function pathProblem(path: string): string | null {
  if (path.length === 0) return "Add a path";
  if (path.length > MAX_PATH_LENGTH) return `Use at most ${MAX_PATH_LENGTH} characters`;
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) return `Pages can be nested at most ${MAX_PATH_DEPTH} levels deep`;
  if (!segments.every(isValidSlug)) {
    return "Use lowercase letters, digits and dashes, with / between levels (e.g. onboarding/laptop)";
  }
  return null;
}

const TRANSLITERATIONS: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  æ: "ae",
  ø: "oe",
  å: "aa",
  œ: "oe",
  ł: "l",
  đ: "d",
};

/** A slug from a title: "Laptop & VPN (Mac)" → "laptop-vpn-mac". */
export function slugify(text: string, fallback = "page"): string {
  const slug = text
    .toLowerCase()
    .replace(/[äöüßæøåœłđ]/g, (character) => TRANSLITERATIONS[character] ?? character)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function lastSegment(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** The parent's path, or null for a top-level page. */
export function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

/** The paths of a page's ancestors, top first: "a/b/c" has "a" and "a/b". */
export function ancestorPaths(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function joinPath(parent: string | null | undefined, slug: string): string {
  return parent ? `${parent}/${slug}` : slug;
}

/** True when `path` is `ancestor` or below it. */
export function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** The web app's URL of a page (path relative to the host). */
export function pageUrl(space: string, path: string, anchor?: string | null): string {
  return `/s/${space}/${path}${anchor ? `#${anchor}` : ""}`;
}

/** The URL of a page's Markdown file. */
export function pageMarkdownUrl(space: string, path: string): string {
  return `/s/${space}/${path}.md`;
}

export type LinkTarget =
  | { kind: "page"; space: string; path: string; anchor: string | null }
  /** A link that looks like a page link but cannot be one (e.g. `../` above the top). */
  | { kind: "invalid" }
  | { kind: "anchor"; anchor: string }
  | { kind: "file"; href: string }
  | { kind: "external"; href: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Removes `.md`, `/index` and `index.md` endings, as between Markdown files. */
function stripFileEnding(path: string): string {
  let result = path.replace(/\/+$/, "");
  result = result.replace(/\.md$/i, "");
  if (result === "index") return "";
  if (result.endsWith("/index")) result = result.slice(0, -"/index".length);
  return result;
}

/**
 * What a link in a page points to. `from` is the page that contains the link.
 * Relative links resolve like files: the page `a/b` is the file `a/b.md`.
 */
export function resolveLink(href: string, from: { space: string; path: string }): LinkTarget {
  const trimmed = href.trim();
  if (trimmed === "") return { kind: "invalid" };
  if (trimmed.startsWith("#")) return { kind: "anchor", anchor: decode(trimmed.slice(1)) };
  if (SCHEME.test(trimmed) || trimmed.startsWith("//")) return { kind: "external", href: trimmed };

  const hashIndex = trimmed.indexOf("#");
  const anchor = hashIndex === -1 ? null : decode(trimmed.slice(hashIndex + 1)) || null;
  let target = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const queryIndex = target.indexOf("?");
  if (queryIndex !== -1) target = target.slice(0, queryIndex);
  target = decode(target);

  if (target.startsWith("/files/")) return { kind: "file", href: trimmed };
  if (target.startsWith("/s/")) {
    const rest = target.slice(3).replace(/\.md$/i, "");
    const slash = rest.indexOf("/");
    const space = slash === -1 ? rest : rest.slice(0, slash);
    const path = stripFileEnding(slash === -1 ? "" : rest.slice(slash + 1));
    if (!isValidSpaceSlug(space)) return { kind: "invalid" };
    if (path === "") return { kind: "page", space, path: "", anchor };
    return isValidPath(path) ? { kind: "page", space, path, anchor } : { kind: "invalid" };
  }
  if (target.startsWith("/")) return { kind: "external", href: trimmed };

  const segments = from.path.split("/").slice(0, -1);
  for (const part of stripFileEnding(target).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return { kind: "invalid" };
      segments.pop();
    } else segments.push(part);
  }
  if (segments.length === 0) return { kind: "page", space: from.space, path: "", anchor };
  const path = segments.join("/");
  return isValidPath(path) ? { kind: "page", space: from.space, path, anchor } : { kind: "invalid" };
}
