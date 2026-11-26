/**
 * The MCP tools call the REST API in-process, as the caller: every request
 * carries the caller's `Authorization` header and runs through the same
 * middleware and services as an HTTP request (authentication, access,
 * validation, change set rules).
 */

/** Hands a request to the application (its `fetch`). */
export type ApiDispatch = (request: Request) => Promise<Response>;

/** An error answer of the API: status, stable code, a message for people, field messages. */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export type ApiClient = {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body: unknown): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
};

/** Request headers passed on from the MCP request to every API call. */
const FORWARDED = ["authorization", "x-forwarded-for"] as const;

/** A client for `/api/v1` on behalf of the MCP request `incoming`. */
export function apiClient(dispatch: ApiDispatch, incoming: Request, requestId?: string): ApiClient {
  const origin = new URL(incoming.url).origin;
  const base: Record<string, string> = { accept: "application/json" };
  for (const name of FORWARDED) {
    const value = incoming.headers.get(name);
    if (value) base[name] = value;
  }
  if (requestId) base["x-request-id"] = requestId;
  const agent = incoming.headers.get("user-agent");
  base["user-agent"] = agent ? `${agent} (MCP)`.slice(0, 500) : "MCP client";

  async function call<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`/api/v1${path}`, origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = new Headers(base);
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    const response = await dispatch(new Request(url, { method, headers, body }));
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const payload = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const error = payload.error as
        { code?: string; message?: string; fields?: Record<string, string> } | undefined;
      throw new ApiCallError(
        response.status,
        error?.code ?? "internal_error",
        error?.message ?? `The request failed (${response.status})`,
        error?.fields,
        payload,
      );
    }
    return data as T;
  }

  return {
    get: (path, query) => call("GET", path, { query }),
    post: (path, body) => call("POST", path, { body: body ?? {} }),
    put: (path, body) => call("PUT", path, { body }),
    patch: (path, body) => call("PATCH", path, { body }),
    delete: (path) => call("DELETE", path),
  };
}
