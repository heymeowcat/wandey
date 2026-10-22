/**
 * Inline SVG icons. Keeping them here avoids an icon dependency and a font
 * request, which is in the spirit of a small local app.
 */

const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.4 2.4 3.6 5.4 3.6 9S14.4 18.6 12 21c-2.4-2.4-3.6-5.4-3.6-9S9.6 5.4 12 3Z",
  spark: "m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z",
  send: "M4 12 21 4l-3.5 17L12 15l-8-3Z M12 15v6",
  stop: "M7 7h10v10H7z",
  close: "M6 6l12 12M18 6 6 18",
  copy: "M8 8h11v12H8zM5 16V4h11",
  external: "M14 4h6v6M20 4l-9 9M19 14v5H5V5h5",
  chevron: "m9 6 6 6-6 6",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z",
  menu: "M4 7h16M4 12h16M4 17h16",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16ZM4 19a2 2 0 0 1 2-2h14",
  check: "m5 12 4.5 4.5L19 7",
  alert: "M12 3 2.5 20h19L12 3ZM12 9v5M12 17.5v.5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  doc: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6",
  layers: "m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
};

export function icon(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[name] ?? PATHS.spark!);
  svg.append(path);
  return svg;
}

export function iconLabel(name: string, label: string, size = 16): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "icon-label";
  span.append(icon(name, size), document.createTextNode(label));
  return span;
}
