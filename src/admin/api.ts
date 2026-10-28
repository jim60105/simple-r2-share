/**
 * The three admin API calls (admin UI spec §5). Any non-2xx answer throws an
 * `ApiError` with the HTTP status; a network failure has status `0`.
 *
 * Requests do not follow redirects: when the Access session has expired, the
 * edge answers with a redirect to the (cross-origin) login page, which fetch
 * could not follow anyway. That case is reported as `403`, so the page asks
 * the admin to reload and sign in again.
 */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`admin api answered ${status}${code === null ? "" : ` (${code})`}`);
  }
}

export interface RulesResponse {
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string | null;
  readonly savedAt: string | null;
  readonly user: { readonly email: string | null };
  readonly brandName: string;
  readonly rulesKey: string;
  /** Why the file could not be read (too large, not UTF-8). */
  readonly invalid?: string;
}

export interface FoldersResponse {
  readonly folders: readonly string[];
  readonly cursor: string | null;
}

export interface SaveResponse {
  readonly etag: string;
  readonly savedAt: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "manual",
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch {
    throw new ApiError(0, null);
  }
  if (response.type === "opaqueredirect") throw new ApiError(403, null);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(response.status, typeof body?.error === "string" ? body.error : null);
  }
  return (await response.json()) as T;
}

export function fetchRules(): Promise<RulesResponse> {
  return call("/api/admin/rules");
}

/** One page of folders below `prefix` (`""` or a path ending with `/`). */
export function fetchFolders(prefix: string, cursor: string | null): Promise<FoldersResponse> {
  const params = new URLSearchParams({ prefix });
  if (cursor !== null) params.set("cursor", cursor);
  return call(`/api/admin/folders?${params}`);
}

/** Saves the rules file; `etag` is `null` for the first save. */
export function saveRules(text: string, etag: string | null): Promise<SaveResponse> {
  return call("/api/admin/rules", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, etag }),
  });
}
