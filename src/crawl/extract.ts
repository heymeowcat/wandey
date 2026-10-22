import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { hostOf, resolveURL } from "../core/url.ts";
import { truncate, wordCount } from "../core/util.ts";

/**
 * HTML -> readable Markdown.
 *
 * Mozilla Readability finds the article body; Turndown turns it into Markdown
 * the model can read without burning context on markup. Link extraction uses
 * the *original* document so navigation still feeds the crawler.
 */
export interface ExtractedPage {
  title: string;
  siteName: string;
  markdown: string;
  text: string;
  links: string[];
  headings: string[];
  excerpt: string;
  byline: string;
  publishedTime: string;
  canonical: string;
  words: number;
  isProbablyJSApp: boolean;
}

let converter: TurndownService | null = null;

function turndown(): TurndownService {
  if (converter) return converter;
  const instance = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  instance.use(gfm);
  instance.remove(["script", "style", "noscript", "template", "iframe", "object", "embed"]);
  converter = instance;
  return instance;
}

export function extractHTML(html: string, url: string): ExtractedPage {
  // Very large pages are usually generated junk; cap before parsing.
  const source = html.length > 4_000_000 ? html.slice(0, 4_000_000) : html;
  const { document } = parseHTML(source);

  const links = new Set<string>();
  const anchors = document.querySelectorAll("a[href]");
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i] as unknown as Element;
    const href = anchor.getAttribute?.("href") ?? "";
    const resolved = resolveURL(href, url);
    if (resolved) links.add(resolved);
    if (links.size > 3000) break;
  }

  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const canonical = canonicalHref ? resolveURL(canonicalHref, url) ?? url : url;
  const meta = (names: string[]): string => {
    for (const name of names) {
      const node = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const content = node?.getAttribute("content");
      if (content?.trim()) return content.trim();
    }
    return "";
  };

  const ogTitle = meta(["og:title", "twitter:title"]);
  const description = meta(["og:description", "description", "twitter:description"]);
  const siteName = meta(["og:site_name"]);
  const byline = meta(["author", "article:author"]);
  const publishedTime = meta(["article:published_time", "date", "pubdate", "datePublished"]);

  // Data-URI images are pure context bloat.
  const images = document.querySelectorAll('img[src^="data:"]');
  for (let i = 0; i < images.length; i++) {
    (images[i] as unknown as Element).setAttribute?.("src", "");
  }

  let title = ogTitle || document.title || hostOf(url);
  let articleText = "";
  let articleHTML = "";
  let excerpt = description;
  let articleByline = byline;
  let articleSite = siteName;
  let articlePublished = publishedTime;

  try {
    const reader = new Readability(document as unknown as Document, {
      charThreshold: 100,
      keepClasses: false,
    });
    const article = reader.parse();
    if (article) {
      title = article.title?.trim() || title;
      articleText = article.textContent?.trim() || "";
      articleHTML = article.content || "";
      excerpt = article.excerpt?.trim() || excerpt;
      articleByline = article.byline?.trim() || articleByline;
      articleSite = article.siteName?.trim() || articleSite;
      articlePublished = article.publishedTime?.trim() || articlePublished;
    }
  } catch {
    // Readability is best-effort; the fallback below always works.
  }

  if (!articleText || articleText.length < 120) {
    const body = document.querySelector("main, article, [role='main'], body");
    articleHTML = body?.innerHTML ?? "";
    articleText = (body?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  let markdown = "";
  try {
    markdown = articleHTML ? turndown().turndown(articleHTML) : "";
  } catch {
    markdown = "";
  }
  if (!markdown.trim()) markdown = articleText;

  markdown = cleanMarkdown(markdown);
  const text = articleText.replace(/\s+/g, " ").trim();

  const headings: string[] = [];
  try {
    const parsed = parseHTML(articleHTML || source);
    const nodes = parsed.document.querySelectorAll("h1, h2, h3");
    for (let i = 0; i < nodes.length && headings.length < 30; i++) {
      const heading = (nodes[i] as unknown as Element).textContent?.replace(/\s+/g, " ").trim();
      if (heading) headings.push(heading);
    }
  } catch {
    // headings are a nicety, not required
  }

  const scriptCount = document.querySelectorAll("script").length;
  const isProbablyJSApp = text.length < 400 && scriptCount > 5;

  return {
    title: title || hostOf(url),
    siteName: articleSite || siteName || hostOf(url),
    markdown: truncate(markdown, 2_000_000),
    text: truncate(text, 2_000_000),
    links: [...links],
    headings,
    excerpt,
    byline: articleByline,
    publishedTime: articlePublished,
    canonical,
    words: wordCount(text),
    isProbablyJSApp,
  };
}

export function markdownTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^\s*#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

/** A rough plain-text projection of Markdown, for snippets and word counts. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[a-z0-9+#-]*\n([\s\S]*?)```/gi, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function markdownLinks(markdown: string, base: string): string[] {
  const links = new Set<string>();
  const regex = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown))) {
    if (match[1]) links.add(match[1]);
    if (links.size > 2000) break;
  }
  // Also pick up bare URLs so reader output can still feed the crawl frontier.
  const bare = /(?<!\()https?:\/\/[^\s<>)"']+/g;
  while ((match = bare.exec(markdown))) {
    if (match[0]) links.add(match[0].replace(/[.,;:]+$/, ""));
    if (links.size > 3000) break;
  }
  return [...links].filter((link) => {
    try {
      return new URL(link).hostname.length > 0;
    } catch {
      return false;
    }
  });
}

function cleanMarkdown(markdown: string): string {
  // Readability/Turndown occasionally leave raw table HTML behind (common on
  // old forums). Clean it outside fenced code so code samples stay untouched.
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  const cleaned = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
        .replace(/<\/t[dh]>/gi, " | ")
        .replace(/<[^>]+>/g, "");
    })
    .join("");

  return cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n? \| ?\n?/g, " | ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * PDF text extraction uses the system's poppler if available. This keeps the
 * default install tiny; when poppler is missing the fetcher falls back to the
 * configured reader service.
 */
export async function extractPDF(
  bytes: Uint8Array,
  options: { command?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ text: string; error?: string }> {
  const command = options.command ?? "pdftotext";
  const binary = command.includes("/") ? command : Bun.which(command);
  if (!binary) {
    return { text: "", error: "pdftotext is not installed (optional; install poppler or enable the reader fallback)" };
  }

  const temp = `${Bun.env.TMPDIR ?? "/tmp"}/wandey-${crypto.randomUUID()}.pdf`;
  try {
    await Bun.write(temp, bytes);
    const proc = Bun.spawn([binary, "-layout", "-enc", "UTF-8", temp, "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }, options.timeoutMs ?? 30_000);
    const [text, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);
    if (exitCode !== 0 && !text.trim()) {
      return { text: "", error: `pdftotext failed: ${stderr.trim().slice(0, 300)}` };
    }
    return { text: text.replace(/\r\n/g, "\n").slice(0, 2_000_000) };
  } catch (err) {
    return { text: "", error: `PDF extraction failed: ${(err as Error).message}` };
  } finally {
    try {
      await Bun.file(temp).delete();
    } catch {
      // ignore
    }
  }
}
