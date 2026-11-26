import { ApiError, apiUrl } from "@/lib/api";

/**
 * Calls of the editor that need the whole error body (409 conflicts with
 * the merged text, 423 locks with their holder) or `keepalive` (releasing a
 * lock while the page closes). Other calls use `api` from @/lib/api.
 */
export type RawResponse = { ok: boolean; status: number; body: unknown };

export async function rawRequest(
  method: string,
  path: string,
  options: { body?: unknown; keepalive?: boolean; signal?: AbortSignal } = {},
): Promise<RawResponse> {
  const response = await fetch(apiUrl(path), {
    method,
    credentials: "same-origin",
    keepalive: options.keepalive,
    signal: options.signal,
    headers:
      options.body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, body: parseJson(text) };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The ApiError of an unexpected answer, with the server's message and field errors. */
export function apiErrorOf(response: RawResponse): ApiError {
  const error = (
    response.body as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null
  )?.error;
  return new ApiError(
    response.status,
    error?.code ?? "internal_error",
    error?.message ?? `Request failed (${response.status})`,
    error?.fields,
  );
}
