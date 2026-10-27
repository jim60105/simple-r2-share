/** Bindings and variables available to Pages Functions (see wrangler.toml). */
export interface Env {
  BUCKET: R2Bucket;
  R2_PUBLIC_BASE_URL?: string;
  ENABLE_ZIP_DOWNLOAD?: string;
  SHARE_RULES_KEY?: string;
  FOOTER_HTML?: string;
}

export interface AppConfig {
  /**
   * Public R2 base URL without a trailing slash, e.g. `https://files.example.com`
   * or `https://cdn.example.com/bucket`. Build object URLs as
   * `${publicBaseUrl}/${encodedSegments.join("/")}`.
   */
  publicBaseUrl: string;
  zipEnabled: boolean;
  shareRulesKey: string;
  /** Trusted footer HTML rendered verbatim, or `null` for no footer. */
  footerHtml: string | null;
}

export const DEFAULT_SHARE_RULES_KEY = ".r2-share-rules";

/** Invalid deployment settings. Routes should answer with the generic error page. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

type ConfigVars = Omit<Env, "BUCKET">;

export function loadConfig(env: ConfigVars): AppConfig {
  return {
    publicBaseUrl: parsePublicBaseUrl(env.R2_PUBLIC_BASE_URL),
    zipEnabled: env.ENABLE_ZIP_DOWNLOAD === "true",
    shareRulesKey: env.SHARE_RULES_KEY || DEFAULT_SHARE_RULES_KEY,
    footerHtml: footerHtmlFromEnv(env),
  };
}

/**
 * The footer setting on its own (unset or empty means no footer). Routes use it
 * to keep the footer on the generic error page when `loadConfig` throws
 * `ConfigError` because of another setting.
 */
export function footerHtmlFromEnv(env: Pick<ConfigVars, "FOOTER_HTML">): string | null {
  return env.FOOTER_HTML || null;
}

function parsePublicBaseUrl(raw: string | undefined): string {
  if (raw === undefined || !raw.startsWith("https://")) {
    throw new ConfigError("R2_PUBLIC_BASE_URL must be an https:// URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("R2_PUBLIC_BASE_URL is not a valid URL");
  }
  // Object keys are appended as path segments, so anything after the path
  // (or credentials in front of the host) would corrupt every generated link.
  if (url.username || url.password || url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    throw new ConfigError("R2_PUBLIC_BASE_URL must not contain credentials, a query or a fragment");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}
