// ---------------------------------------------------------------------------
// Plain-text extraction from an uploaded Word (.docx) contract template.
//
// A .docx is a ZIP archive; the body lives in word/document.xml. This reads the
// archive with Node's own zlib (no new dependency), then turns each Word
// paragraph into one line of text. Runs inside a paragraph are joined first, so
// a placeholder Word split across formatting runs ("{{CLIENT_" + "NAME}}")
// is reassembled before the placeholders are checked.
//
// This text is the template's searchable wording and the on-screen preview.
// The contract itself is produced on the uploaded Word file (see docxFill.js),
// so the template's own design - letterhead, logo, fonts, tables - is kept.
// ---------------------------------------------------------------------------
import zlib from "node:zlib";

const MAX_ZIP_ENTRIES = 2048;
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;

class DocxError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Returns the uncompressed bytes of one entry of a ZIP archive, or null. */
function readZipEntry(buffer, wantedName) {
  // End Of Central Directory: signature 0x06054b50, within the last 64 KB.
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new DocxError("the file is not a valid Word (.docx) document");
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries > MAX_ZIP_ENTRIES) throw new DocxError("the Word document contains too many archive entries");
  let pointer = buffer.readUInt32LE(eocd + 16);
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (pointer < 0 || pointer + 46 > eocd) throw new DocxError("the Word document archive is damaged");
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new DocxError("the Word document contains an oversized archive entry");
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) throw new DocxError("the Word document expands beyond the allowed size");
    if (name === wantedName) {
      if (localOffset < 0 || localOffset + 30 > buffer.length || localOffset + 30 + compressedSize > buffer.length) {
        throw new DocxError("the Word document archive is damaged");
      }
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new DocxError("the Word document is damaged");
      const localName = buffer.readUInt16LE(localOffset + 26);
      const localExtra = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      if (start + compressedSize > buffer.length) throw new DocxError("the Word document archive is damaged");
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) {
        if (compressedSize !== uncompressedSize) throw new DocxError("the Word document archive is damaged");
        return data;
      }
      if (method === 8) {
        const expanded = zlib.inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
        if (expanded.length !== uncompressedSize) throw new DocxError("the Word document archive is damaged");
        return expanded;
      }
      throw new DocxError("the Word document uses an unsupported compression method");
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const decodeXml = (text) => text
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, "&");

/** Word document XML -> template text, one paragraph per line. */
export function docxXmlToText(xml) {
  const body = xml.replace(/^[\s\S]*?<w:body[^>]*>/, "").replace(/<w:sectPr[\s\S]*$/, "");
  const lines = [];
  for (const paragraph of body.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) || []) {
    const style = (paragraph.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "";
    let text = "";
    for (const token of paragraph.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br[^>]*\/>/g) || []) {
      if (token.startsWith("<w:tab")) text += "\t";
      else if (token.startsWith("<w:br")) text += "\n";
      else text += decodeXml(token.replace(/^<w:t[^>]*>/, "").replace(/<\/w:t>$/, ""));
    }
    text = text.replace(/\s+$/, "");
    if (/^(Title|Heading1)$/i.test(style) && text) text = `# ${text}`;
    else if (/^Heading[2-9]$/i.test(style) && text) text = `## ${text}`;
    lines.push(text);
  }
  // Collapse runs of empty paragraphs to a single blank line.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Extracts the template text from an uploaded .docx or .txt file buffer. */
export function templateTextFromUpload(buffer, extension) {
  if (extension === ".txt") return buffer.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
  if (extension !== ".docx") throw new DocxError("upload the template as a Word .docx file (or plain .txt)");
  const xml = readZipEntry(buffer, "word/document.xml");
  if (!xml) throw new DocxError("the Word document has no body (word/document.xml is missing)");
  return docxXmlToText(xml.toString("utf8"));
}
