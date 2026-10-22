import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";

/**
 * Markdown that is safe by construction: raw HTML is disabled, links open in a
 * new tab, and citations are turned into clickable source chips after rendering
 * (so they never run inside code blocks or URLs).
 */

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre class="hljs"><code class="language-${escapeHtml(language)}">${hljs.highlight(code, {
          language,
          ignoreIllegals: true,
        }).value}</code></pre>`;
      } catch {
        // Fall through to plain text.
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
});

const linkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]?.attrSet("target", "_blank");
  tokens[index]?.attrSet("rel", "noopener noreferrer");
  return linkOpen
    ? linkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};

export function renderMarkdown(text: string): string {
  return md.render(text || "");
}

export function setMarkdown(root: HTMLElement, text: string): void {
  root.innerHTML = renderMarkdown(text);
  enhanceMarkdown(root);
}

export function enhanceMarkdown(root: HTMLElement): void {
  linkCitations(root);
  addCopyButtons(root);
  wrapTables(root);
}

/** Replace [s3] / [S3] in text nodes with source buttons. */
function linkCitations(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("pre, code, a, .citation")) return NodeFilter.FILTER_REJECT;
      return /\[s\d+\]/i.test(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) replaceCitations(node);
}

function replaceCitations(node: Text): void {
  const text = node.textContent ?? "";
  const regex = /\[(s\d+)\]/gi;
  let match: RegExpExecArray | null;
  let cursor = 0;
  const fragment = document.createDocumentFragment();

  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));
    const id = match[1]!.toLowerCase();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "citation";
    button.dataset.citation = id;
    button.title = `Open source ${id}`;
    button.textContent = id.toUpperCase();
    fragment.append(button);
    cursor = match.index + match[0].length;
  }

  if (cursor === 0) return;
  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
  node.replaceWith(fragment);
}

function addCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("code-shell")) continue;
    const shell = document.createElement("div");
    shell.className = "code-shell";
    pre.replaceWith(shell);
    shell.append(pre);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      const text = pre.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy";
        }, 1_500);
      } catch {
        button.textContent = "Failed";
      }
    });
    shell.append(button);
  }
}

function wrapTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll("table")) {
    if (table.parentElement?.classList.contains("table-wrap")) continue;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
