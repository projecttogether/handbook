import { z } from "zod";
import { idSchema } from "./common";

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, "Enter a search").max(200),
  space: z.string().optional(),
  tag: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** Marks around matched words in `snippet`. */
export const HIGHLIGHT_START = "\u0002";
export const HIGHLIGHT_END = "\u0003";

/** The best matching section of one page. */
export const searchResultSchema = z.object({
  pageId: idSchema,
  space: z.object({ slug: z.string(), name: z.string() }),
  path: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  /** Headings above the matching section, from the page's top. */
  headingPath: z.array(z.string()),
  anchor: z.string().nullable(),
  /** Full URL of the page (and section). */
  url: z.string(),
  /** Text around the match; matched words between HIGHLIGHT_START and HIGHLIGHT_END. */
  snippet: z.string(),
  tags: z.array(z.string()),
  type: z.string().nullable(),
  score: z.number(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
export const searchResponseSchema = z.object({ results: z.array(searchResultSchema) });
export type SearchResponse = z.infer<typeof searchResponseSchema>;
