// Payment evidence is untrusted binary input. Browser-supplied MIME types and
// filenames are advisory only; reject payloads which disagree with their bytes.
export const ACCEPTED_RECEIPT_TYPES = Object.freeze(["image/jpeg", "image/png", "application/pdf"]);

export function detectReceiptType(input) {
  if (!Buffer.isBuffer(input) || input.length < 8) return null;
  if (input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (input.subarray(0, 3).equals(Buffer.from([255,216,255])) &&
      input.length >= 4 && input.subarray(-2).equals(Buffer.from([255,217]))) return "image/jpeg";
  // PDF header can be preceded by a short binary leader, but a valid PDF must
  // also contain a final trailer marker. Keep uploads constrained to PDFs only.
  if (input.subarray(0, 5).toString("ascii") === "%PDF-" &&
      input.subarray(-2048).includes(Buffer.from("%%EOF"))) return "application/pdf";
  return null;
}

export function isReceiptConsistent(buffer, claimedMime) {
  return ACCEPTED_RECEIPT_TYPES.includes(claimedMime) && detectReceiptType(buffer) === claimedMime;
}
