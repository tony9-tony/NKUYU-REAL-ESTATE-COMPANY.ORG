// ---------------------------------------------------------------------------
// Plain-text extraction from an uploaded Word (.docx) contract template.
//
// A .docx is a ZIP archive; the body lives in word/document.xml. This reads the
// archive with Node's own zlib (no new dependency), then turns each Word
// paragraph into one line of text. Runs inside a paragraph are joined first, so
// a placeholder Word split across formatting runs ("{{CLIENT_" + "NAME}}")
// is reassembled before the placeholders are checked.
//
// Headings are kept as Markdown-style "#"/"##" lines, which is the format the
// contract document writer already understands. Other formatting (fonts,
// tables, logos) is not carried over: the template supplies the WORDING, and
// the system produces the finished document in the MKUYU house style.
// ---------------------------------------------------------------------------
import zlib from "node:zlib";

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
  let pointer = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    if (name === wantedName) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new DocxError("the Word document is damaged");
      const localName = buffer.readUInt16LE(localOffset + 26);
      const localExtra = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
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
