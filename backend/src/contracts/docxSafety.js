import { inflateRawSync } from "node:zlib";

export const MAX_DOCX_ENTRIES = 2048;
export const MAX_DOCX_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_DOCX_TOTAL_BYTES = 64 * 1024 * 1024;

export function assertSafeDocxArchive(zip) {
  const entries = Object.values(zip?.files || {});
  if (entries.length > MAX_DOCX_ENTRIES) throw new Error("the Word document contains too many archive entries");

  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const source = entry._data;
    const compressedSize = Number(source?.compressedSize);
    const uncompressedSize = Number(source?.uncompressedSize);
    if (!Number.isSafeInteger(compressedSize) || compressedSize < 0 || !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
      throw new Error("the Word document has invalid archive sizes");
    }
    if (uncompressedSize > MAX_DOCX_ENTRY_BYTES) throw new Error("the Word document contains an oversized archive entry");
    const compressed = source?.compressedContent;
    let expanded;
    if (source.compression?.magic === "\x00\x00") expanded = Buffer.from(compressed || []);
    else if (source.compression?.magic === "\x08\x00") expanded = inflateRawSync(compressed, { maxOutputLength: MAX_DOCX_ENTRY_BYTES });
    else throw new Error("the Word document uses an unsupported compression method");
    if (expanded.length !== uncompressedSize) throw new Error("the Word document has invalid archive sizes");
    totalBytes += expanded.length;
    if (totalBytes > MAX_DOCX_TOTAL_BYTES) throw new Error("the Word document expands beyond the allowed size");
  }
  return zip;
}