import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * True when running the production bundle (dist/main.mjs), false when
 * running the TypeScript sources (development, tests).
 */
export const IS_BUNDLED = path.basename(here) === "dist";

/** apps/server: this file lives in src/ and is bundled into dist/, both one level below. */
export const SERVER_ROOT = path.resolve(here, "..");
