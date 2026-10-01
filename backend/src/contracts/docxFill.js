// ---------------------------------------------------------------------------
// Contract generation ON the uploaded Word template.
//
// When a staff member uploads their own Word (.docx) contract template, the
// generated contract must look exactly like it: letterhead, logo, fonts,
// tables, headers and footers. So instead of re-typesetting the wording, this
// module opens the template file itself and replaces only the {{PLACEHOLDERS}}
// with the contract's values, leaving every other byte of the design alone.
//
// Word often splits typed text across several formatting runs
// ("{{CLIENT_" + "NAME}}"), so placeholders are matched on the paragraph's
// joined text and the replacement is written back into the first run the
// placeholder started in (keeping that run's font, size and bold/italic).
//
// {{LAWYER_SIGNATURE}} is special: before Legal approval it prints a blank
// signing line; once a lawyer with an uploaded signature approves, the same
// spot receives the signature image, their name, title and the date. A
// template without that placeholder gets the signature block at the end.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { documentUploadsDir, extensionMime, resolveStoredFile } from "../uploads.js";
import { contractFileName, contractStoredName, imageSize, unknownPlaceholders } from "./workflow.js";

const SIGNATURE_SENTINEL = "MKUYU-SIGNATURE";
const BLANK_SIGNING_LINE = "____________________________";
const SIGNATURE_REL_ID = "rIdMkuyuSignature";

/** Word parts that may carry placeholders: the body, headers and footers. */
const FILLABLE_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

const escapeXml = (text) => String(text ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const decodeXml = (text) => text
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, "&");

// Paragraph open/close tags and text nodes, in document order. `<w:pPr>`,
// `<w:tab/>`, `<w:tbl>` and friends are deliberately NOT matched.
const XML_TOKEN = /<w:p(?=[\s>/])[^>]*?(\/?)>|<\/w:p>|<w:t(?=[\s>])[^>]*>([\s\S]*?)<\/w:t>/g;

/** Every paragraph's text nodes, grouped by the innermost paragraph. */
function paragraphTextNodes(xml) {
  const groups = [];
  const stack = [];
  for (const match of xml.matchAll(XML_TOKEN)) {
    const token = match[0];
    if (token.startsWith("</w:p")) { stack.pop(); continue; }
    if (token.startsWith("<w:p")) {
      if (match[1] === "/") continue; // <w:p/> - an empty paragraph
      const group = [];
      groups.push(group);
      stack.push(group);
      continue;
    }
    const current = stack[stack.length - 1];
    if (!current) continue;
    current.push({ start: match.index, end: match.index + token.length, text: decodeXml(match[2]) });
  }
  return groups;
}

/** All placeholder-looking tokens in one XML part (runs joined per paragraph). */
function partText(xml) {
  return paragraphTextNodes(xml).map((nodes) => nodes.map((node) => node.text).join("")).join("\n");
}

const TOKEN = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

/**
 * Replaces the placeholders in one XML part. `values[TOKEN]` is the text to
 * insert; a token with no value is left exactly as written so a gap is visible.
 */
function fillPart(xml, values) {
  const edits = [];
  for (const nodes of paragraphTextNodes(xml)) {
    if (!nodes.length) continue;
    const joined = nodes.map((node) => node.text).join("");
    if (!joined.includes("{{")) continue;
    const texts = nodes.map((node) => node.text);
    // Offsets of each node inside the joined paragraph text.
    const starts = [];
    let cursor = 0;
    for (const text of texts) { starts.push(cursor); cursor += text.length; }
    const matches = [...joined.matchAll(TOKEN)].filter((match) => Object.prototype.hasOwnProperty.call(values, match[1]));
    if (!matches.length) continue;
    // Right to left, so earlier offsets stay valid while later text changes.
    for (const match of matches.reverse()) {
      const from = match.index;
      const to = match.index + match[0].length;
      let first = -1;
      for (let index = 0; index < texts.length; index += 1) {
        const nodeStart = starts[index];
        const nodeEnd = nodeStart + nodes[index].text.length;
        if (nodeEnd <= from || nodeStart >= to) continue;
        const cutFrom = Math.max(from, nodeStart) - nodeStart;
        const cutTo = Math.min(to, nodeEnd) - nodeStart;
        // Matches are handled right to left, so everything before `cutTo` in
        // this node is still the original text and the offsets stay valid.
        if (first < 0) {
          first = index;
          texts[index] = texts[index].slice(0, cutFrom) + String(values[match[1]] ?? "") + texts[index].slice(cutTo);
        } else {
          texts[index] = texts[index].slice(0, cutFrom) + texts[index].slice(cutTo);
        }
      }
    }
    nodes.forEach((node, index) => {
      if (texts[index] !== node.text) edits.push({ ...node, replacement: `<w:t xml:space="preserve">${escapeXml(texts[index])}</w:t>` });
    });
  }
  let output = xml;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

/** Size of the signature picture in EMU: about 1.9" wide, never taller than 0.9". */
function signatureExtent(image) {
  const size = imageSize(image);
  const maxWidth = 1800000;
  const maxHeight = 820000;
  if (!size?.width || !size?.height) return { cx: maxWidth, cy: 640000, type: size?.type || "png" };
  let cx = maxWidth;
  let cy = Math.round(cx * size.height / size.width);
  if (cy > maxHeight) { cy = maxHeight; cx = Math.round(cy * size.width / size.height); }
  return { cx, cy, type: size.type };
}

function signatureDrawing(extent) {
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${extent.cx}" cy="${extent.cy}"/><wp:docPr id="90210" name="Lawyer signature"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="signature"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${SIGNATURE_REL_ID}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${extent.cx}" cy="${extent.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

/** The signer's details under the picture, as runs sharing `rPr`. */
function signerRuns(signature, rPr) {
  const lines = [signature.name, signature.title, signature.date ? `Date: ${signature.date}` : ""].filter(Boolean);
  return lines.map((line) => `<w:r>${rPr}<w:br/><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`).join("");
}

/**
 * Puts the signature where {{LAWYER_SIGNATURE}} was: the run holding the
 * sentinel is split into [text before][picture + signer lines][text after].
 */
function placeSignatureAtSentinel(xml, signature, extent) {
  const runPattern = /<w:r(?=[\s>])[^>]*>((?:(?!<\/w:r>)[\s\S])*?)<w:t xml:space="preserve">([^<]*?)MKUYU-SIGNATURE([^<]*)<\/w:t>((?:(?!<\/w:r>)[\s\S])*?)<\/w:r>/g;
  let placed = false;
  const output = xml.replace(runPattern, (_, before, textBefore, textAfter, after) => {
    const rPr = (before.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [""])[0];
    placed = true;
    return `<w:r>${before}<w:t xml:space="preserve">${textBefore}</w:t></w:r>`
      + `<w:r>${rPr}${signatureDrawing(extent)}</w:r>${signerRuns(signature, rPr)}`
      + `<w:r>${rPr}<w:t xml:space="preserve">${textAfter}</w:t>${after}</w:r>`;
  });
  return { xml: output, placed };
}

/** A template without {{LAWYER_SIGNATURE}}: the signature block goes at the end. */
function appendSignatureBlock(xml, signature, extent) {
  const block = `<w:p><w:pPr><w:spacing w:before="360"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(`Signed for and on behalf of ${signature.company || "the Company"} (Legal)`)}</w:t></w:r></w:p>`
    + `<w:p><w:r>${signatureDrawing(extent)}</w:r>${signerRuns(signature, "")}</w:p>`;
  const lastSection = xml.lastIndexOf("<w:sectPr");
  const bodyEnd = xml.lastIndexOf("</w:body>");
  const at = lastSection > -1 && lastSection < bodyEnd ? lastSection : bodyEnd;
  return xml.slice(0, at) + block + xml.slice(at);
}

/** Makes sure the body declares the namespaces the picture markup uses. */
function ensureNamespaces(xml) {
  const needed = {
    "xmlns:wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  };
  return xml.replace(/<w:document\b[^>]*>/, (tag) => {
    let result = tag;
    for (const [name, uri] of Object.entries(needed)) {
      if (!new RegExp(`\\s${name}=`).test(result)) result = result.replace(/>$/, ` ${name}="${uri}">`);
    }
    return result;
  });
}

async function addSignatureMedia(zip, image, type) {
  const extension = type === "jpg" ? "jpeg" : "png";
  const target = `media/mkuyu-signature.${extension}`;
  zip.file(`word/${target}`, image, { createFolders: false });
  const relsPath = "word/_rels/document.xml.rels";
  let rels = zip.file(relsPath) ? await zip.file(relsPath).async("string")
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  rels = rels.replace(new RegExp(`<Relationship[^>]*Id="${SIGNATURE_REL_ID}"[^>]*/>`), "");
  rels = rels.replace("</Relationships>", `<Relationship Id="${SIGNATURE_REL_ID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`);
  zip.file(relsPath, rels);
  let types = await zip.file("[Content_Types].xml").async("string");
  if (!new RegExp(`<Default[^>]*Extension="${extension}"`, "i").test(types)) {
    types = types.replace("</Types>", `<Default Extension="${extension}" ContentType="image/${extension}"/></Types>`);
    zip.file("[Content_Types].xml", types);
  }
}

async function openTemplate(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    if (!zip.file("word/document.xml")) throw new Error("missing body");
    return zip;
  } catch {
    const error = new Error("the file is not a valid Word (.docx) document");
    error.status = 400;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// {{CONTRACT_BODY}}: the agreement wording, placed ON the template.
//
// A letterhead template (logo, company details, borders, footer) marks where
// the contract text goes with {{CONTRACT_BODY}}. The paragraph holding it is
// replaced by the agreement's own paragraphs - title, numbered clauses,
// bullets - written in the template's font, so the content sits inside the
// template's design. Word flows the text onto as many pages as it needs, and
// the template's header and footer repeat on every one of them.
// ---------------------------------------------------------------------------
const BODY_TOKEN = /\{\{\s*CONTRACT_BODY\s*\}\}/;
const PARAGRAPH = /<w:p(?=[\s>])[^>]*>[\s\S]*?<\/w:p>/g;

/** Font and colour of the run the placeholder was typed in, without size or emphasis. */
function baseRunProperties(paragraphXml) {
  const rPr = (paragraphXml.match(/<w:r(?=[\s>])[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/) || [])[1] || "";
  return rPr
    .replace(/^<w:rPr>|<\/w:rPr>$/g, "")
    .replace(/<w:(b|bCs|i|iCs|u|sz|szCs|caps|smallCaps|highlight|vertAlign)\b[^>]*\/>/g, "");
}

function run(text, rPr, extra = "") {
  return `<w:r><w:rPr>${rPr}${extra}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** Agreement text (agreements.js line syntax) -> WordprocessingML paragraphs. */
export function agreementXml(text, rPr = "") {
  const out = [];
  // The signature section is kept together on one page (Word "keep with next").
  let signatures = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^##\s+Signatures\b/i.test(line)) signatures = true;
    if (signatures && !/^#{1,3}\s/.test(line)) {
      out.push(`<w:p><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr>${run(line, rPr)}</w:p>`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading && heading[1].length === 1) {
      out.push(`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="80"/></w:pPr>${run(heading[2].toUpperCase(), rPr, '<w:b/><w:sz w:val="32"/><w:szCs w:val="32"/>')}</w:p>`);
    } else if (heading) {
      out.push(`<w:p><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/></w:pPr>${run(heading[2].toUpperCase(), rPr, '<w:b/>')}</w:p>`);
    } else if (/^[-*]\s+/.test(line)) {
      out.push(`<w:p><w:pPr><w:spacing w:after="60"/><w:ind w:left="567" w:hanging="283"/></w:pPr>${run(`• ${line.replace(/^[-*]\s+/, "")}`, rPr)}</w:p>`);
    } else if (/^>\s?/.test(line)) {
      out.push(`<w:p><w:pPr><w:spacing w:after="100"/></w:pPr>${run(line.replace(/^>\s?/, ""), rPr, '<w:i/><w:sz w:val="18"/>')}</w:p>`);
    } else if (/^Contract number:/i.test(line)) {
      out.push(`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr>${run(line, rPr, '<w:sz w:val="18"/>')}</w:p>`);
    } else {
      out.push(`<w:p><w:pPr><w:jc w:val="both"/><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr>${run(line, rPr)}</w:p>`);
    }
  }
  return out.join("");
}

/** Replaces the paragraph holding {{CONTRACT_BODY}} with the agreement's paragraphs. */
function expandContractBody(xml, bodyText) {
  if (bodyText === undefined || bodyText === null) return xml;
  return xml.replace(PARAGRAPH, (paragraph) => {
    const text = [...paragraph.matchAll(/<w:t(?=[\s>])[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1])).join("");
    if (!BODY_TOKEN.test(text)) return paragraph;
    return agreementXml(bodyText, baseRunProperties(paragraph));
  });
}

// ---------------------------------------------------------------------------
// The template's page design on every page.
//
// A design drawn in the BODY - a full-page background picture, a border frame
// or a watermark placed "Behind text" - would only appear on the first page
// once the agreement runs longer. Such pictures are moved into the page header,
// which Word repeats on every page, so a two- or five-page contract carries the
// template on each page. Letterheads already in the header need nothing.
// ---------------------------------------------------------------------------
const BEHIND_TEXT_RUN = /<w:r(?=[\s>])[^>]*>(?:(?!<\/w:r>)[\s\S])*?<wp:anchor\b[^>]*\bbehindDoc="(?:1|true)"[\s\S]*?<\/wp:anchor>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g;
const RELATIONSHIP = /<Relationship\b[^>]*\/>/g;
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

async function repeatPageDesign(zip) {
  const documentPath = "word/document.xml";
  let body = await zip.file(documentPath).async("string");
  const runs = body.match(BEHIND_TEXT_RUN);
  if (!runs?.length) return;
  const relsPath = "word/_rels/document.xml.rels";
  const docRels = zip.file(relsPath) ? await zip.file(relsPath).async("string") : "";
  const relById = new Map((docRels.match(RELATIONSHIP) || []).map((tag) => [attr(tag, "Id"), tag]));

  // The default header of the last section; one is created when there is none.
  const sectPr = body.lastIndexOf("<w:sectPr");
  const sectEnd = body.indexOf("</w:sectPr>", sectPr);
  if (sectPr < 0 || sectEnd < 0) return;
  const section = body.slice(sectPr, sectEnd);
  const headerRef = (section.match(/<w:headerReference\b[^>]*\/>/g) || []).find((tag) => attr(tag, "w:type") === "default");
  let headerPath;
  let rels = docRels;
  if (headerRef) {
    const target = attr(relById.get(attr(headerRef, "r:id")) || "", "Target");
    if (!target) return;
    headerPath = `word/${target.replace(/^\/?word\//, "")}`;
  } else {
    let index = 1;
    while (zip.file(`word/header${index}.xml`)) index += 1;
    headerPath = `word/header${index}.xml`;
    const id = "rIdMkuyuHeader";
    zip.file(headerPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:p/></w:hdr>`);
    rels = rels.replace("</Relationships>", `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${headerPath.replace("word/", "")}"/></Relationships>`);
    zip.file(relsPath, rels);
    let types = await zip.file("[Content_Types].xml").async("string");
    types = types.replace("</Types>", `<Override PartName="/${headerPath}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`);
    zip.file("[Content_Types].xml", types);
    const reference = `<w:headerReference w:type="default" r:id="${id}"/>`;
    body = body.slice(0, sectPr) + body.slice(sectPr, sectEnd).replace(/(<w:sectPr\b[^>]*>)/, `$1${reference}`) + body.slice(sectEnd);
  }
  const headerFile = zip.file(headerPath);
  if (!headerFile) return;
  let header = await headerFile.async("string");

  // Pictures keep their relationship ids: each one the runs use is copied into
  // the header's own relationships.
  const headerRelsPath = headerPath.replace(/^word\//, "word/_rels/") + ".rels";
  let headerRels = zip.file(headerRelsPath) ? await zip.file(headerRelsPath).async("string")
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  for (const id of new Set(runs.join("").match(/r:(?:embed|link|id)="([^"]+)"/g)?.map((m) => m.split('"')[1]) || [])) {
    const tag = relById.get(id);
    if (tag && !new RegExp(`\\bId="${id}"`).test(headerRels)) headerRels = headerRels.replace("</Relationships>", `${tag}</Relationships>`);
  }
  zip.file(headerRelsPath, headerRels);

  // Anchored to the page (not to a paragraph), so they sit where they were.
  const moved = runs.map((run) => run.replace(/<wp:positionV\b[^>]*relativeFrom="paragraph"/g, (tag) => tag.replace('relativeFrom="paragraph"', 'relativeFrom="page"')));
  header = header.replace(/<w:p(?=[\s>/])[^>]*?(\/?)>/, (tag, selfClosing) => (selfClosing ? `<w:p>${moved.join("")}</w:p>` : `${tag}${moved.join("")}`));
  for (const [name, uri] of Object.entries({ "xmlns:wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "xmlns:a": "http://schemas.openxmlformats.org/drawingml/2006/main", "xmlns:pic": "http://schemas.openxmlformats.org/drawingml/2006/picture" })) {
    if (!new RegExp(`\\s${name}=`).test(header.match(/<w:hdr\b[^>]*>/)?.[0] || "")) header = header.replace(/<w:hdr\b([^>]*)>/, `<w:hdr$1 ${name}="${uri}">`);
  }
  zip.file(headerPath, header);
  for (const run of runs) body = body.replace(run, "");
  zip.file(documentPath, body);
}

/** Unknown placeholders anywhere in the template, headers and footers included. */
export async function templateFileUnknownPlaceholders(buffer) {
  const zip = await openTemplate(buffer);
  const unknown = [];
  for (const name of Object.keys(zip.files).filter((entry) => FILLABLE_PART.test(entry))) {
    for (const token of unknownPlaceholders(partText(await zip.file(name).async("string")))) {
      if (!unknown.includes(token)) unknown.push(token);
    }
  }
  return unknown;
}

/**
 * Fills `buffer` (the template .docx) with `values` and, when given, places
 * the lawyer's `signature` ({ image, name, title, company, date }).
 * Returns the finished .docx bytes.
 */
export async function fillWordTemplate(buffer, values, signature = null) {
  const zip = await openTemplate(buffer);
  // The template's page design first, so it repeats however long the text runs.
  await repeatPageDesign(zip);
  // The agreement wording goes where the template says {{CONTRACT_BODY}}; its
  // own placeholders (the lawyer's signature spot) are filled with the rest.
  const { CONTRACT_BODY: bodyText, ...rest } = values || {};
  if (bodyText !== undefined) {
    zip.file("word/document.xml", expandContractBody(await zip.file("word/document.xml").async("string"), bodyText));
  }
  const hasSignature = Boolean(signature?.image);
  const fillValues = { ...rest, LAWYER_SIGNATURE: hasSignature ? SIGNATURE_SENTINEL : BLANK_SIGNING_LINE };
  const extent = hasSignature ? signatureExtent(signature.image) : null;
  let signaturePlaced = false;
  for (const name of Object.keys(zip.files).filter((entry) => FILLABLE_PART.test(entry))) {
    const partValues = name === "word/document.xml" ? fillValues : { ...fillValues, LAWYER_SIGNATURE: BLANK_SIGNING_LINE };
    // CONTRACT_BODY outside the body (a header, say) is only ever plain text.
    if (bodyText !== undefined && name !== "word/document.xml") partValues.CONTRACT_BODY = "";
    let xml = fillPart(await zip.file(name).async("string"), partValues);
    if (name === "word/document.xml" && hasSignature) {
      const result = placeSignatureAtSentinel(xml, signature, extent);
      xml = result.xml.split(SIGNATURE_SENTINEL).join(BLANK_SIGNING_LINE);
      signaturePlaced = result.placed;
      if (!signaturePlaced) xml = appendSignatureBlock(xml, signature, extent);
      xml = ensureNamespaces(xml);
    }
    zip.file(name, xml);
  }
  if (hasSignature) await addSignatureMedia(zip, signature.image, extent.type);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** The template's own .docx on disk, or null when it was typed, not uploaded. */
export function templateWordFile(template) {
  if (!template?.stored_name || !/\.docx$/i.test(template.original_filename || template.stored_name)) return null;
  return resolveStoredFile(documentUploadsDir, template.stored_name);
}

/** Fills the template file and stores the result like any generated contract. */
export async function generateFromWordTemplate({ templatePath, values, title, contractNumber, signature = null }) {
  const bytes = await fillWordTemplate(fs.readFileSync(templatePath), values, signature);
  const originalFilename = contractFileName(contractNumber, title);
  const storedName = contractStoredName(originalFilename);
  const target = path.join(documentUploadsDir, storedName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { file_size: bytes.length, mime_type: extensionMime[".docx"], stored_name: storedName, original_filename: originalFilename };
}
