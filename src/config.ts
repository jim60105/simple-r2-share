/** Bindings and variables available to Pages Functions (dashboard in production, wrangler.toml locally). */
export interface Env {
  BUCKET: R2Bucket;
  R2_PUBLIC_BASE_URL?: string;
  ENABLE_ZIP_DOWNLOAD?: string;
  SHARE_RULES_KEY?: string;
  FOOTER_HTML?: string;
  BRAND_NAME?: string;
  BRAND_URL?: string;
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
  /** Trusted footer HTML rendered verbatim, or `null` for none (the "Powered by" credit still shows). */
  footerHtml: string | null;
  /** Text of the top bar brand and the `<title>` suffix. */
  brandName: string;
  /** Link target of the top bar brand, or `null` for no link. */
  brandUrl: string | null;
}

/** The settings every page renders around its content: brand and footer. */
export type PageChrome = Pick<AppConfig, "footerHtml" | "brandName" | "brandUrl">;

export const DEFAULT_SHARE_RULES_KEY = ".r2-share-rules";
export const DEFAULT_BRAND_NAME = "SIMPLE R2 SHARE";

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
    ...pageChromeFromEnv(env),
  };
}

/**
 * The brand and footer settings on their own; they never throw. Unset or empty
 * means the default brand name, no brand link and no custom footer. Routes use
 * it to keep them on the generic error page when `loadConfig` throws
 * `ConfigError` because of another setting.
 */
export function pageChromeFromEnv(env: Pick<ConfigVars, "FOOTER_HTML" | "BRAND_NAME" | "BRAND_URL">): PageChrome {
  return {
    footerHtml: env.FOOTER_HTML || null,
    brandName: env.BRAND_NAME || DEFAULT_BRAND_NAME,
    brandUrl: env.BRAND_URL || null,
  };
}

function parsePublicBaseUrl(raw: string | undefined): string {
  if (raw === undefined) {
    throw new ConfigError("R2_PUBLIC_BASE_URL must be set");
  }
  // Custom domains and r2.dev are always served over HTTPS, so a bare host
  // such as `files.example.com` gets the scheme added. A value that names a
  // scheme must name `https://` itself.
  if (!raw.includes("://")) raw = `https://${raw}`;
  if (!raw.startsWith("https://")) {
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
