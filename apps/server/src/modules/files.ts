import { Hono } from "hono";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { badRequest } from "../http/errors";
import { requireUser } from "../http/middleware";
import { requireAbility, spaceContext } from "../spaces/access";
import { saveUpload } from "../files/storage";
import { multipartBody } from "./util";

const router = new Hono<AppEnv>();

/** Uploads a file of a space (multipart field `file`); pages link to its URL. Agents may upload too. */
router.post("/spaces/:space/files", async (c) => {
  const actor = requireUser(c);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  requireAbility(context, "propose");
  const body = await multipartBody(c);
  const file = body.file;
  if (!(file instanceof File)) throw badRequest("Choose a file");
  return c.json(await saveUpload(context.space.id, actor.id, file), 201);
});

export default router;
