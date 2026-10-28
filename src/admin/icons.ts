/** `<svg><use href="#icon-…"></svg>` for the sprite in public/admin/index.html. */

const SVG_NS = "http://www.w3.org/2000/svg";

export type IconName =
  | "logo"
  | "folder"
  | "caret"
  | "inherit"
  | "share"
  | "share-sub"
  | "exclude"
  | "copy"
  | "check"
  | "close";

export function icon(name: IconName, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}
