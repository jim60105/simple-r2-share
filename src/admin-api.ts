/**
 * Admin API helpers (admin UI spec §5). Every response is uncached JSON;
 * errors are `{"error": "<code>"}` and never mention keys or internals.
 */

/** Data the Access middleware passes to the admin API handlers. */
export interface AdminData extends Record<string, unknown> {
  /** `email` of the verified Access JWT; `null` for service tokens. */
  accessEmail: string | null;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
