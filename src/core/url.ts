/**
 * URL hygiene. Deduplication and politeness both depend on agreeing what
 * "the same page" means, so one implementation is used everywhere.
 */

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|source|spm|_ga|yclid)$/i;

const ASSET_EXTENSIONS = new Set([
  // images
  "jpg", "jpeg", "png", "gif", "svg", "webp", "ico", "bmp", "avif", "tif", "tiff", "heic",
  // audio / video
  "mp4", "webm", "mov", "avi", "mkv", "m4v", "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus",
  // archives and binaries
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "dmg", "exe", "msi", "apk", "deb", "rpm", "iso", "bin", "wasm",
  // page assets
  "css", "js", "mjs", "cjs", "map", "woff", "woff2", "ttf", "otf", "eot", "map",
  // structured data we don't want to crawl as pages
  "ics", "vcf",
]);

/** Resolve an anchor href against a page URL. Returns null for non-http(s). */
export function resolveURL(href: string, base: string): string | null {
  const value = decodeHtmlEntities(href).trim();
  if (!value || value.startsWith("#")) return null;
  if (/^(mailto|javascript|tel|data|ftp|file):/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Stable key for dedupe and per-session source identity. */
export function canonicalURL(input: string): string {
  try {
    const url = new URL(input);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    url.hash = "";

    const kept: Array<[string, string]> = [];
    for (const [key, value] of url.searchParams.entries()) {
      if (TRACKING_PARAMS.test(key)) continue;
      kept.push([key, value]);
    }
    kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    url.search = "";
    for (const [key, value] of kept) url.searchParams.append(key, value);

    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return input;
  }
}

export function hostOf(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function originOf(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return "";
  }
}

export function siteOf(input: string): string {
  return hostOf(input);
}

/** True when `url` is on the seed's host or a subdomain of it. */
export function sameSite(url: string, seed: string): boolean {
  const host = hostOf(url);
  const base = hostOf(seed);
  if (!host || !base) return false;
  return host === base || host.endsWith(`.${base}`);
}

export function isAssetURL(input: string): boolean {
  try {
    const url = new URL(input);
    const last = url.pathname.split("/").pop() ?? "";
    const extension = last.includes(".") ? last.split(".").pop()!.toLowerCase() : "";
    return ASSET_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

export function isPDFURL(input: string): boolean {
  try {
    return new URL(input).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

/** Match a URL path against simple prefix/glob patterns like "/docs/*" */
export function matchesPattern(url: string, pattern: string): boolean {
  if (!pattern) return false;
  let target = pattern;
  try {
    target = new URL(url).pathname;
  } catch {
    // use raw string
  }
  if (!pattern.includes("*")) return target.startsWith(pattern);
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(target);
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 5) / 2);
  return `${text.slice(0, half)} ... ${text.slice(-half)}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
