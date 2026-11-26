import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { and, asc, eq, sql } from "drizzle-orm";
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import { stringify as stringifyYaml } from "yaml";
import type { DbOrTx } from "../db/client";
import { files, pages } from "../db/schema";
import { mentionedFileIds, storedFilePath } from "../files/storage";
import { logger } from "../logger";
import type { SpaceContext } from "../spaces/access";
import { spaceVisibility } from "../spaces/visibility";

type Entry =
  { kind: "text"; name: string; text: string } | { kind: "file"; name: string; fileId: string; path: string };

/**
 * Exports a space as a zip: `<path>.md` for every live page (sub-pages in
 * folders named like their page), `_space.yaml` with the space's settings
 * and page order, and every upload these texts use as
 * `files/<id>/<name>`, where the pages' links (`/files/<id>/<name>`) point
 * when the zip's folder is the root. Drafts only for editors.
 *
 * Reads the database before it answers; the zip itself streams, one file
 * after another, as the client takes it.
 */
export async function exportSpace(db: DbOrTx, context: SpaceContext): Promise<ReadableStream<Uint8Array>> {
  const { space } = context;
  const rows = await db
    .select({ path: pages.path, title: pages.title, position: pages.position, markdown: pages.markdown })
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), spaceVisibility(context).livePages()))
    .orderBy(asc(pages.path));
  const entries: Entry[] = rows.map((row) => ({ kind: "text", name: `${row.path}.md`, text: row.markdown }));
  const order = [...rows]
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    .map((row) => row.path);
  entries.push({
    kind: "text",
    name: "_space.yaml",
    text: stringifyYaml(
      {
        name: space.name,
        description: space.description,
        properties: space.properties,
        pageTypes: space.pageTypes,
        order,
      },
      { lineWidth: 0 },
    ),
  });

  const ids = mentionedFileIds(entries.map((entry) => (entry.kind === "text" ? entry.text : null)));
  const uploads =
    ids.length === 0
      ? []
      : await db
          .select({ id: files.id, name: files.name, storageKey: files.storageKey })
          .from(files)
          .where(sql`${files.id} = any(${sql.param(ids)}::uuid[])`)
          .orderBy(asc(files.id));
  for (const upload of uploads) {
    entries.push({
      kind: "file",
      name: `files/${upload.id}/${upload.name}`,
      fileId: upload.id,
      path: storedFilePath(upload.storageKey),
    });
  }
  return ReadableStream.from(zipStream(entries, space.id));
}

/**
 * The zip of `entries`, chunk by chunk: the next file is read and packed
 * only when the client took what came before. Texts are compressed;
 * uploads are stored as they are (images are compressed already). An
 * upload missing on disk is left out and logged.
 */
async function* zipStream(entries: Entry[], spaceId: string): AsyncGenerator<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure ??= error;
    else chunks.push(chunk);
  });
  const ready = function* () {
    if (failure) throw failure;
    yield* chunks.splice(0);
  };
  try {
    for (const entry of entries) {
      if (entry.kind === "text") {
        const file = new ZipDeflate(entry.name, { level: 6 });
        zip.add(file);
        file.push(strToU8(entry.text), true);
        yield* ready();
        // Other requests get their turn between files.
        await nextTurn();
        continue;
      }
      const found = await stat(entry.path).then(
        (info) => info.isFile(),
        () => false,
      );
      if (!found) {
        logger.warn({ fileId: entry.fileId, spaceId }, "export left out an upload missing on disk");
        continue;
      }
      const file = new ZipPassThrough(entry.name);
      zip.add(file);
      for await (const chunk of createReadStream(entry.path, { highWaterMark: 256 * 1024 })) {
        file.push(chunk as Buffer);
        yield* ready();
      }
      file.push(new Uint8Array(0), true);
      yield* ready();
    }
    zip.end();
    yield* ready();
  } catch (error) {
    logger.error({ err: error, spaceId }, "space export failed");
    zip.terminate();
    throw error;
  }
}
