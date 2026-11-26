import type { Context, Hono } from "hono";
import type { AppEnv } from "../http/env";
import { badRequest } from "../http/errors";

export type Router = Hono<AppEnv>;

export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
export const isoRequired = (value: Date) => value.toISOString();

/** The fields of a multipart/form-data request (file uploads). */
export async function multipartBody(c: Context<AppEnv>) {
  return c.req.parseBody().catch(() => {
    throw badRequest("Send the file as multipart/form-data");
  });
}
