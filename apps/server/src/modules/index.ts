import admin from "./admin";
import changes from "./changes";
import files from "./files";
import meta from "./meta";
import pages from "./pages";
import search from "./search";
import spaces from "./spaces";
import tokens from "./tokens";

/** Routers mounted under /api/v1. */
export const API_MODULES = [meta, spaces, pages, search, files, changes, tokens, admin];
