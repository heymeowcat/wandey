import { describe, expect, test } from "bun:test";
import {
  canonicalURL,
  hostOf,
  isAssetURL,
  isPDFURL,
  matchesPattern,
  originOf,
  resolveURL,
  sameSite,
  siteOf,
  truncateMiddle,
} from "../src/core/url.ts";

describe("resolveURL", () => {
  test("resolves relative links, drops fragments, and keeps queries", () => {
    expect(resolveURL("../docs?x=1#section", "https://example.com/a/b/page")).toBe(
      "https://example.com/a/docs?x=1",
    );
    expect(resolveURL("?page=2", "https://example.com/list")).toBe("https://example.com/list?page=2");
  });

  test("rejects non-http links and bare fragments", () => {
    expect(resolveURL("#section", "https://example.com")).toBeNull();
    expect(resolveURL("mailto:hello@example.com", "https://example.com")).toBeNull();
    expect(resolveURL("javascript:alert(1)", "https://example.com")).toBeNull();
    expect(resolveURL("data:text/plain,hello", "https://example.com")).toBeNull();
  });

  test("decodes common HTML entities in hrefs", () => {
    expect(resolveURL("/search?a=1&amp;b=2", "https://example.com")).toBe(
      "https://example.com/search?a=1&b=2",
    );
  });
});

describe("canonicalURL", () => {
  test("normalises host, default port, tracking parameters, sorting, and trailing slashes", () => {
    expect(
      canonicalURL("https://WWW.Example.com:443/Path/?b=2&utm_source=news&a=1&fbclid=x#frag"),
    ).toBe("https://example.com/Path?a=1&b=2");
  });

  test("keeps meaningful duplicate query values in stable order", () => {
    expect(canonicalURL("https://example.com/t?tag=b&tag=a")).toBe(
      "https://example.com/t?tag=a&tag=b",
    );
  });

  test("returns invalid input unchanged", () => {
    expect(canonicalURL("not a URL")).toBe("not a URL");
  });
});

describe("host helpers", () => {
  test("hostOf and siteOf ignore www", () => {
    expect(hostOf("https://WWW.Example.com/a")).toBe("example.com");
    expect(siteOf("https://docs.example.com/a")).toBe("docs.example.com");
    expect(originOf("https://example.com:8443/a")).toBe("https://example.com:8443");
  });

  test("sameSite accepts subdomains but not lookalikes", () => {
    expect(sameSite("https://docs.example.com/a", "https://example.com")).toBe(true);
    expect(sameSite("https://evil-example.com/a", "https://example.com")).toBe(false);
    expect(sameSite("https://example.com.evil.test/a", "https://example.com")).toBe(false);
  });
});

describe("URL classification", () => {
  test("detects assets and PDFs", () => {
    expect(isAssetURL("https://example.com/image.PNG?x=1")).toBe(true);
    expect(isAssetURL("https://example.com/page.html")).toBe(false);
    expect(isPDFURL("https://example.com/report.pdf?download=1")).toBe(true);
    expect(isPDFURL("https://example.com/report")).toBe(false);
  });

  test("matches prefix and glob patterns against paths", () => {
    expect(matchesPattern("https://example.com/docs/a", "/docs")).toBe(true);
    expect(matchesPattern("https://example.com/docs/a", "/docs/*")).toBe(true);
    expect(matchesPattern("https://example.com/blog/a", "/docs/*")).toBe(false);
    expect(matchesPattern("https://example.com/docs/a", "")).toBe(false);
  });
});

describe("truncateMiddle", () => {
  test("leaves short strings and shortens long ones", () => {
    expect(truncateMiddle("hello", 10)).toBe("hello");
    const shortened = truncateMiddle("0123456789abcdefghij", 12);
    expect(shortened.length).toBeLessThanOrEqual(12);
    expect(shortened).toContain(" ... ");
  });
});
