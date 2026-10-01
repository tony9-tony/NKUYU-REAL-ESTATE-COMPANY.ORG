// ---------------------------------------------------------------------------
// Contract preview: the generated Word contract, as it looks, in the browser.
//
// "Open contract" must show the agreement ON the template - letterhead, logo,
// fonts, borders, header and footer on every page - not plain text. This
// module reads the contract's own .docx (the very file that is downloaded) and
// turns it into a description of a page the browser can lay out:
//
//   { page:   { width, height, margin: {top,right,bottom,left}, header, footer }  (px)
//     header: HTML of the page header (repeated on every page)
//     footer: HTML of the page footer (repeated on every page)
//     layers: HTML of pictures placed "Behind text" in the header (every page)
//     firstPageLayers: pictures placed behind text in the body (page 1)
//     blocks: [HTML of each paragraph / table of the body, in order] }
//
// The browser then fills A4 pages with the blocks, repeating the header and
// footer, and writes "Page X of Y" into the PAGE / NUMPAGES fields.
//
// It covers what contracts and letterheads use: paragraphs (alignment,
// spacing, indents, borders), runs (bold, italic, underline, size, colour,
// font), tabs, line breaks, tables, inline and floating pictures, and page
// number fields. Every piece of text is escaped and every style value is
// validated, so a template cannot inject markup into the page.
// ---------------------------------------------------------------------------
import JSZip from "jszip";
import { assertSafeDocxArchive } from "./docxSafety.js";

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" };
const twipsToPx = (value) => Math.round((Number(value) || 0) / 15 * 100) / 100;
const emuToPx = (value) => Math.round((Number(value) || 0) / 9525 * 100) / 100;
const escapeHtml = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeColor = (value) => (/^[0-9A-Fa-f]{6}$/.test(String(value || "")) ? `#${value}` : null);
const safeFont = (value) => (/^[\w .\-]{1,60}$/.test(String(value || "")) ? String(value) : null);

// ---- A small XML reader (the parts are well-formed WordprocessingML) --------
function decode(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

export function parseXml(xml) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const match of String(xml).matchAll(pattern)) {
    const top = stack[stack.length - 1];
    if (match[6] !== undefined) { if (top.name !== "#root") top.children.push({ text: decode(match[6]) }); continue; }
    if (match[1] !== undefined) { top.children.push({ text: match[1] }); continue; }
    if (!match[3]) continue; // comment or processing instruction
    if (match[2] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    for (const attr of (match[4] || "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[attr[1]] = decode(attr[2] ?? attr[3] ?? "");
    const node = { name: match[3], attrs, children: [] };
    top.children.push(node);
    if (match[5] !== "/") stack.push(node);
  }
  return root;
}

const kids = (node, name) => (node?.children || []).filter((child) => child.name && (!name || child.name === name));
const kid = (node, name) => (node?.children || []).find((child) => child.name === name) || null;
const find = (node, name) => {
  if (!node?.children) return null;
  for (const child of node.children) {
    if (child.name === name) return child;
    const hit = find(child, name);
    if (hit) return hit;
  }
  return null;
};
const val = (node, name, attr = "w:val") => kid(node, name)?.attrs?.[attr];
const on = (node, name) => {
  const element = kid(node, name);
  if (!element) return null;
  const value = element.attrs["w:val"];
  return !(value === "0" || value === "false" || value === "none");
};
const textOf = (node) => (node?.children || []).map((child) => (child.text !== undefined ? child.text : textOf(child))).join("");

// ---- Styles ------------------------------------------------------------------
function readStyles(xml) {
  const styles = new Map();
  let defaults = { rPr: null, pPr: null };
  if (!xml) return { styles, defaults };
  const root = parseXml(xml);
  const all = find(root, "w:styles");
  const docDefaults = kid(all, "w:docDefaults");
  defaults = { rPr: find(kid(docDefaults, "w:rPrDefault"), "w:rPr"), pPr: find(kid(docDefaults, "w:pPrDefault"), "w:pPr") };
  for (const style of kids(all, "w:style")) {
    styles.set(style.attrs["w:styleId"], { basedOn: val(style, "w:basedOn"), rPr: kid(style, "w:rPr"), pPr: kid(style, "w:pPr"), type: style.attrs["w:type"], isDefault: style.attrs["w:default"] === "1" });
  }
  return { styles, defaults };
}

/** The chain of style property elements for a style id, nearest last. */
function styleChain(styles, id, key) {
  const chain = [];
  const seen = new Set();
  let current = id;
  while (current && styles.has(current) && !seen.has(current)) {
    seen.add(current);
    const style = styles.get(current);
    if (style[key]) chain.unshift(style[key]);
    current = style.basedOn;
  }
  return chain;
}

// ---- Run formatting ----------------------------------------------------------
function runFormat(chain) {
  const format = {};
  for (const rPr of chain) {
    if (!rPr) continue;
    for (const [name, key] of [["w:b", "bold"], ["w:i", "italic"], ["w:caps", "caps"], ["w:strike", "strike"]]) {
      const state = on(rPr, name);
      if (state !== null) format[key] = state;
    }
    const underline = val(rPr, "w:u");
    if (underline !== undefined) format.underline = underline !== "none";
    const size = Number(val(rPr, "w:sz"));
    if (size > 0) format.size = size / 2;
    const color = safeColor(val(rPr, "w:color"));
    if (color) format.color = color;
    const fonts = kid(rPr, "w:rFonts");
    const font = safeFont(fonts?.attrs?.["w:ascii"] || fonts?.attrs?.["w:hAnsi"]);
    if (font) format.font = font;
    const spacing = Number(val(rPr, "w:spacing"));
    if (spacing) format.letterSpacing = twipsToPx(spacing);
    const highlight = val(rPr, "w:highlight");
    if (highlight && /^[a-zA-Z]+$/.test(highlight) && highlight !== "none") format.highlight = highlight;
  }
  return format;
}

function runStyle(format) {
  const css = [];
  if (format.bold) css.push("font-weight:700");
  if (format.italic) css.push("font-style:italic");
  if (format.underline || format.strike) css.push(`text-decoration:${[format.underline ? "underline" : "", format.strike ? "line-through" : ""].filter(Boolean).join(" ")}`);
  if (format.size) css.push(`font-size:${format.size}pt`);
  if (format.color) css.push(`color:${format.color}`);
  if (format.font) css.push(`font-family:'${format.font}',serif`);
  if (format.caps) css.push("text-transform:uppercase");
  if (format.letterSpacing) css.push(`letter-spacing:${format.letterSpacing}px`);
  if (format.highlight) css.push(`background:${format.highlight}`);
  return css.join(";");
}

// ---- Paragraph formatting ----------------------------------------------------
function paragraphFormat(chain) {
  const format = {};
  for (const pPr of chain) {
    if (!pPr) continue;
    const jc = val(pPr, "w:jc");
    if (jc) format.align = { both: "justify", distribute: "justify", center: "center", right: "right", end: "right", left: "left", start: "left" }[jc] || format.align;
    const spacing = kid(pPr, "w:spacing");
    if (spacing) {
      if (spacing.attrs["w:before"] !== undefined) format.before = twipsToPx(spacing.attrs["w:before"]);
      if (spacing.attrs["w:after"] !== undefined) format.after = twipsToPx(spacing.attrs["w:after"]);
      if (spacing.attrs["w:line"] !== undefined) {
        const line = Number(spacing.attrs["w:line"]);
        format.line = spacing.attrs["w:lineRule"] === "exact" || spacing.attrs["w:lineRule"] === "atLeast" ? `${twipsToPx(line)}px` : String(Math.max(0.8, line / 240) * 1.15);
      }
    }
    const ind = kid(pPr, "w:ind");
    if (ind) {
      const left = ind.attrs["w:left"] ?? ind.attrs["w:start"];
      if (left !== undefined) format.left = twipsToPx(left);
      const right = ind.attrs["w:right"] ?? ind.attrs["w:end"];
      if (right !== undefined) format.right = twipsToPx(right);
      if (ind.attrs["w:hanging"] !== undefined) format.indent = -twipsToPx(ind.attrs["w:hanging"]);
      else if (ind.attrs["w:firstLine"] !== undefined) format.indent = twipsToPx(ind.attrs["w:firstLine"]);
    }
    const borders = kid(pPr, "w:pBdr");
    for (const side of ["top", "bottom"]) {
      const border = kid(borders, `w:${side}`);
      if (border && border.attrs["w:val"] !== "none" && border.attrs["w:val"] !== "nil") {
        format[`border_${side}`] = { width: Math.max(1, Math.round((Number(border.attrs["w:sz"]) || 4) / 6)), color: safeColor(border.attrs["w:color"]) || "#000", space: Math.round((Number(border.attrs["w:space"]) || 0) * 1.33) };
      }
    }
    const shading = safeColor(kid(pPr, "w:shd")?.attrs?.["w:fill"]);
    if (shading) format.shading = shading;
    if (kid(pPr, "w:numPr")) format.list = true;
    if (on(pPr, "w:pageBreakBefore")) format.pageBreak = true;
    if (on(pPr, "w:keepNext")) format.keepNext = true;
    const tabs = kids(kid(pPr, "w:tabs"), "w:tab");
    if (tabs.length) format.tabs = tabs.map((tab) => ({ type: tab.attrs["w:val"], position: twipsToPx(tab.attrs["w:pos"]) }));
  }
  return format;
}

function paragraphStyle(format) {
  const css = [`margin:${format.before ?? 0}px ${format.right ?? 0}px ${format.after ?? 0}px ${format.left ?? 0}px`];
  if (format.align) css.push(`text-align:${format.align}`);
  if (format.line) css.push(`line-height:${format.line}`);
  if (format.indent) css.push(`text-indent:${format.indent}px`);
  for (const side of ["top", "bottom"]) {
    const border = format[`border_${side}`];
    if (border) css.push(`border-${side}:${border.width}px solid ${border.color}`, `padding-${side}:${border.space}px`);
  }
  if (format.shading) css.push(`background:${format.shading}`);
  return css.join(";");
}

// ---- The converter -------------------------------------------------------------
class Converter {
  constructor(zip, styles) {
    this.zip = zip;
    this.styles = styles;
    this.layers = [];
  }

  async rels(partPath) {
    const relsPath = partPath.replace(/^(.*\/)?([^/]+)$/, (_, dir = "", file) => `${dir}_rels/${file}.rels`);
    const file = this.zip.file(relsPath);
    const map = new Map();
    if (!file) return map;
    for (const rel of kids(find(parseXml(await file.async("string")), "Relationships"), "Relationship")) {
      map.set(rel.attrs.Id, rel.attrs.Target);
    }
    return map;
  }

  async image(rels, partDir, id) {
    const target = rels.get(id);
    if (!target || /^https?:/i.test(target)) return null;
    const path = target.startsWith("/") ? target.slice(1) : `${partDir}${target}`.replace(/[^/]+\/\.\.\//g, "");
    const file = this.zip.file(path);
    const type = IMAGE_TYPES[(path.split(".").pop() || "").toLowerCase()];
    if (!file || !type) return null;
    return `data:${type};base64,${await file.async("base64")}`;
  }

  /** A whole part (body, header or footer) -> block HTML strings. */
  async part(partPath, container) {
    const rels = await this.rels(partPath);
    const partDir = partPath.replace(/[^/]+$/, "");
    this.context = { rels, partDir, part: partPath };
    const blocks = [];
    for (const node of kids(container)) {
      if (node.name === "w:p") blocks.push(await this.paragraph(node));
      else if (node.name === "w:tbl") blocks.push(await this.table(node));
      else if (node.name === "w:sdt") {
        for (const inner of kids(kid(node, "w:sdtContent"))) {
          if (inner.name === "w:p") blocks.push(await this.paragraph(inner));
          else if (inner.name === "w:tbl") blocks.push(await this.table(inner));
        }
      }
    }
    return blocks.filter((block) => block !== null);
  }

  async paragraph(node) {
    const pPr = kid(node, "w:pPr");
    const styleId = val(pPr, "w:pStyle") || [...this.styles.styles.entries()].find(([, s]) => s.type === "paragraph" && s.isDefault)?.[0];
    const paragraph = paragraphFormat([this.styles.defaults.pPr, ...styleChain(this.styles.styles, styleId, "pPr"), pPr]);
    const baseRun = [this.styles.defaults.rPr, ...styleChain(this.styles.styles, styleId, "rPr"), kid(pPr, "w:rPr")];
    // Split at tab characters: a right tab (letterheads: name left, title
    // right) is laid out as a row with the pieces pushed apart.
    const segments = [[]];
    this.field = null;
    await this.inline(node, baseRun, segments);
    const htmlOf = (segment) => segment.join("") || "";
    let inner;
    if (segments.length > 1) {
      const rightTab = (paragraph.tabs || []).some((tab) => tab.type === "right" || tab.type === "end");
      inner = rightTab || segments.length === 2
        ? `<span class="docx-tabrow">${segments.map((segment) => `<span>${htmlOf(segment)}</span>`).join("")}</span>`
        : segments.map(htmlOf).join('<span class="docx-tab"></span>');
    } else inner = htmlOf(segments[0]);
    if (paragraph.list && !/^\s*(•|-|\d)/.test(textOf(node))) inner = `<span class="docx-bullet">•</span>${inner}`;
    const empty = !inner.trim();
    const size = runFormat(baseRun).size;
    return `<p class="docx-p${paragraph.pageBreak ? " docx-page-break" : ""}${paragraph.keepNext ? " docx-keep-next" : ""}" style="${paragraphStyle(paragraph)}${size ? `;font-size:${size}pt` : ""}">${empty ? "&nbsp;" : inner}</p>`;
  }

  async inline(node, baseRun, segments) {
    for (const child of kids(node)) {
      if (child.name === "w:r") await this.run(child, baseRun, segments);
      else if (["w:hyperlink", "w:ins", "w:smartTag", "w:customXml", "w:fldSimple", "w:sdt", "w:sdtContent"].includes(child.name)) {
        const instruction = child.name === "w:fldSimple" ? String(child.attrs["w:instr"] || "").trim().split(/\s+/)[0].toUpperCase() : null;
        if (instruction === "PAGE" || instruction === "NUMPAGES") {
          segments[segments.length - 1].push(`<span class="docx-field" data-field="${instruction}">1</span>`);
          continue;
        }
        await this.inline(child, baseRun, segments);
      }
    }
  }

  async run(node, baseRun, segments) {
    const format = runFormat([...baseRun, ...styleChain(this.styles.styles, val(kid(node, "w:rPr"), "w:rStyle"), "rPr"), kid(node, "w:rPr")]);
    const style = runStyle(format);
    const wrap = (html) => (style ? `<span style="${style}">${html}</span>` : html);
    for (const child of kids(node)) {
      const out = segments[segments.length - 1];
      if (child.name === "w:fldChar") {
        const type = child.attrs["w:fldCharType"];
        if (type === "begin") this.field = { instruction: "", showing: false };
        else if (type === "separate" && this.field) this.field.showing = true;
        else if (type === "end" && this.field) {
          const name = this.field.instruction.trim().split(/\s+/)[0].toUpperCase();
          if (name === "PAGE" || name === "NUMPAGES") out.push(wrap(`<span class="docx-field" data-field="${name}">1</span>`));
          this.field = null;
        }
        continue;
      }
      if (child.name === "w:instrText") { if (this.field) this.field.instruction += textOf(child); continue; }
      // A known page field shows its own number; any other field shows its result.
      if (this.field) {
        const name = this.field.instruction.trim().split(/\s+/)[0].toUpperCase();
        if (name === "PAGE" || name === "NUMPAGES" || !this.field.showing) continue;
      }
      if (child.name === "w:t") {
        // A tab typed inside the text acts like a <w:tab/>.
        const pieces = textOf(child).split("\t");
        pieces.forEach((piece, index) => {
          if (index > 0) segments.push([]);
          if (piece) segments[segments.length - 1].push(wrap(escapeHtml(piece)));
        });
      }
      else if (child.name === "w:tab") segments.push([]);
      else if (child.name === "w:br" || child.name === "w:cr") out.push(child.attrs["w:type"] === "page" ? '<span class="docx-break-page"></span>' : "<br>");
      else if (child.name === "w:noBreakHyphen") out.push("‑");
      else if (child.name === "w:drawing" || child.name === "w:pict" || child.name === "mc:AlternateContent") {
        const html = await this.drawing(child);
        if (html) out.push(html);
      }
    }
  }

  async drawing(node) {
    const inline = find(node, "wp:inline");
    const anchor = find(node, "wp:anchor");
    const frame = inline || anchor;
    if (!frame) return "";
    const extent = kid(frame, "wp:extent");
    const width = emuToPx(extent?.attrs?.cx);
    const height = emuToPx(extent?.attrs?.cy);
    const blip = find(frame, "a:blip");
    const src = blip ? await this.image(this.context.rels, this.context.partDir, blip.attrs["r:embed"]) : null;
    if (!src || !width || !height) return "";
    const img = `<img src="${src}" alt="" style="width:${width}px;height:${height}px">`;
    if (inline) return `<span class="docx-img">${img}</span>`;
    // A floating picture is placed on the page itself (relative to the page or
    // the margins); behind text it sits under the words.
    const position = (axis) => {
      const holder = kid(anchor, axis === "h" ? "wp:positionH" : "wp:positionV");
      return { from: holder?.attrs?.relativeFrom || "page", offset: emuToPx(textOf(kid(holder, "wp:posOffset")) || 0), align: textOf(kid(holder, "wp:align")) || null };
    };
    const layer = { h: position("h"), v: position("v"), width, height, behind: anchor.attrs.behindDoc === "1" || anchor.attrs.behindDoc === "true", src };
    this.layers.push({ part: this.context.part, layer });
    return "";
  }

  async table(node) {
    const grid = kids(kid(node, "w:tblGrid"), "w:gridCol").map((col) => twipsToPx(col.attrs["w:w"]));
    const tblPr = kid(node, "w:tblPr");
    const borders = kid(tblPr, "w:tblBorders");
    const bordered = borders && kids(borders).some((side) => !["none", "nil"].includes(side.attrs["w:val"]));
    const rows = [];
    for (const row of kids(node, "w:tr")) {
      const cells = [];
      for (const cell of kids(row, "w:tc")) {
        const tcPr = kid(cell, "w:tcPr");
        const span = Number(val(tcPr, "w:gridSpan")) || 1;
        const merge = kid(tcPr, "w:vMerge");
        if (merge && merge.attrs["w:val"] !== "restart") continue;
        const fill = safeColor(kid(tcPr, "w:shd")?.attrs?.["w:fill"]);
        const width = twipsToPx(kid(tcPr, "w:tcW")?.attrs?.["w:w"]);
        const content = (await this.part(this.context.part, cell)).join("");
        cells.push(`<td${span > 1 ? ` colspan="${span}"` : ""} style="${[width ? `width:${width}px` : "", fill ? `background:${fill}` : "", bordered ? "border:1px solid #888" : ""].filter(Boolean).join(";")}">${content}</td>`);
      }
      rows.push(`<tr>${cells.join("")}</tr>`);
    }
    const width = grid.reduce((sum, col) => sum + col, 0);
    return `<table class="docx-table" style="${width ? `width:${width}px;` : ""}border-collapse:collapse">${rows.join("")}</table>`;
  }
}

function layerHtml({ layer }, page) {
  const place = (axis) => {
    const position = layer[axis];
    const size = axis === "h" ? layer.width : layer.height;
    const pageSize = axis === "h" ? page.width : page.height;
    const start = axis === "h" ? page.margin.left : page.margin.top;
    const area = axis === "h" ? page.width - page.margin.left - page.margin.right : page.height - page.margin.top - page.margin.bottom;
    const fromPage = position.from === "page";
    const origin = fromPage ? 0 : start;
    const span = fromPage ? pageSize : area;
    if (position.align === "center") return origin + (span - size) / 2;
    if (position.align === "right" || position.align === "bottom") return origin + span - size;
    if (position.align === "left" || position.align === "top") return origin;
    return origin + position.offset;
  };
  return `<img class="docx-layer${layer.behind ? " docx-behind" : ""}" src="${layer.src}" alt="" style="left:${Math.round(place("h"))}px;top:${Math.round(place("v"))}px;width:${layer.width}px;height:${layer.height}px">`;
}

/** The contract's .docx -> a page description the browser lays out. */
export async function docxToPreview(buffer) {
  const zip = assertSafeDocxArchive(await JSZip.loadAsync(buffer));
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) throw new Error("not a Word document");
  const styles = readStyles(await zip.file("word/styles.xml")?.async("string"));
  const root = parseXml(await documentFile.async("string"));
  const body = find(root, "w:body");
  const sectPr = [...kids(body, "w:sectPr")].pop() || find(body, "w:sectPr");
  const size = kid(sectPr, "w:pgSz");
  const margins = kid(sectPr, "w:pgMar");
  const page = {
    width: twipsToPx(size?.attrs?.["w:w"] || 11906),
    height: twipsToPx(size?.attrs?.["w:h"] || 16838),
    margin: {
      top: twipsToPx(margins?.attrs?.["w:top"] ?? 1440),
      right: twipsToPx(margins?.attrs?.["w:right"] ?? 1440),
      bottom: twipsToPx(margins?.attrs?.["w:bottom"] ?? 1440),
      left: twipsToPx(margins?.attrs?.["w:left"] ?? 1440),
    },
    header: twipsToPx(margins?.attrs?.["w:header"] ?? 720),
    footer: twipsToPx(margins?.attrs?.["w:footer"] ?? 720),
  };
  const converter = new Converter(zip, styles);
  const docRels = await converter.rels("word/document.xml");
  const partFor = (kind) => {
    const refs = kids(sectPr, `w:${kind}Reference`);
    const ref = refs.find((r) => r.attrs["w:type"] === "default") || refs[0];
    const target = ref && docRels.get(ref.attrs["r:id"]);
    return target ? `word/${target.replace(/^\/?word\//, "")}` : null;
  };
  const partHtml = async (path, tag) => {
    const file = path && zip.file(path);
    if (!file) return "";
    return (await converter.part(path, find(parseXml(await file.async("string")), tag))).join("");
  };
  const headerPath = partFor("header");
  const footerPath = partFor("footer");
  const header = await partHtml(headerPath, "w:hdr");
  const footer = await partHtml(footerPath, "w:ftr");
  const blocks = await converter.part("word/document.xml", body);
  const fromHeaders = converter.layers.filter((entry) => entry.part === headerPath || entry.part === footerPath);
  const fromBody = converter.layers.filter((entry) => entry.part === "word/document.xml");
  return {
    page,
    header,
    footer,
    layers: fromHeaders.map((entry) => layerHtml(entry, page)),
    firstPageLayers: fromBody.map((entry) => layerHtml(entry, page)),
    blocks,
  };
}
