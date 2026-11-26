import type { MiddlewareHandler } from "hono";
import { compress } from "hono/compress";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from "hono/utils/compress";

/**
 * Compresses text responses (JSON, HTML, Markdown) with gzip for clients
 * that accept it. Never /mcp, whose responses stream events, nor uploaded
 * files (/files), which go out as stored; event streams elsewhere stay
 * uncompressed too. The web app's built assets have compressed copies
 * (static.ts).
 */
export function compression(): MiddlewareHandler {
  const gzip = compress({
    encoding: "gzip",
    contentTypeFilter: (type) =>
      !/^\s*text\/event-stream/i.test(type) && COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type),
  });
  return (c, next) => {
    const path = c.req.path;
    if (path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/files/")) return next();
    return gzip(c, next);
  };
}
