/** Edit locks (docs/architecture.md, "Edit locks"). */
export const LOCK_RENEW_SECONDS = 30;
/** A lock ends this long after the editor stopped renewing it (tab closed, laptop asleep). */
export const LOCK_EXPIRE_SECONDS = 120;
/** A lock ends this long after the last typing. */
export const LOCK_IDLE_SECONDS = 30 * 60;
/** The editor saves a draft this often while there are unsaved changes. */
export const DRAFT_SAVE_SECONDS = 5;

/** Uploaded files (images and attachments of pages). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Image types shown inline; every other file downloads. */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
