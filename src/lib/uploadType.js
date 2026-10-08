import { detectReceiptType } from "./receiptType.js";

// File assets are client-provided bytes. A claimed MIME type is not proof of
// the file format; only supported binary signatures may reach the database.
export function detectAssetType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 20 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16))) {
    const size = buffer.readUInt32LE(4);
    // RIFF size excludes its own 8-byte header. Reject truncated containers.
    const chunkBytes = buffer.readUInt32LE(16);
    if (size + 8 <= buffer.length && size >= 12 && chunkBytes <= size - 12) return "image/webp";
  }
  return detectReceiptType(buffer);
}

export const isAssetContentValid = (buffer, mime) =>
  detectAssetType(buffer) === mime;
