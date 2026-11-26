import { z } from "zod";

export const idSchema = z.uuid();

/** Every error response: `{ error: { code, message, fields? } }`. Messages are shown to people. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Optional text: blank becomes null. */
export const nullableText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable(),
  );

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const okSchema = z.object({ ok: z.literal(true) });

/** Who did something, as lists and histories show it. */
export const actorSchema = z.object({
  id: idSchema.nullable(),
  name: z.string(),
  email: z.string().nullable(),
});
export type Actor = z.infer<typeof actorSchema>;
