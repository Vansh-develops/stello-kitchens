import { MEDIA_LIMITS } from "@stello/shared";

export type ImageInfo = { type: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp"; width: number; height: number };

/**
 * Identify an image by its magic bytes (never trust the client's Content-Type
 * or filename) and read its pixel dimensions from the header. Returns null for
 * anything that is not a well-formed JPEG, PNG or WebP.
 */
export function inspectImage(buf: Buffer): ImageInfo | null {
  if (buf.length < 24) return null;
  // PNG: signature + IHDR chunk first.
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
    return { type: "image/png", ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk.
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP" && buf.length >= 30) {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") {
      return { type: "image/webp", ext: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { type: "image/webp", ext: "webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return { type: "image/webp", ext: "webp", width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    return null;
  }
  // JPEG: SOI, then walk segments to the first SOFn frame header.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { type: "image/jpeg", ext: "jpg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** Throws a user-facing message when an upload is not an acceptable menu photo. */
export function validateImage(buf: Buffer, maxBytes: number = MEDIA_LIMITS.maxBytes): ImageInfo {
  if (buf.length === 0) throw new Error("The file is empty");
  if (buf.length > maxBytes) throw new Error(`Image is larger than ${Math.round(maxBytes / 1024)} KB`);
  const info = inspectImage(buf);
  if (!info) throw new Error("Only JPEG, PNG or WebP images are allowed");
  if (info.width < 1 || info.height < 1) throw new Error("Image has no pixels");
  if (info.width > MEDIA_LIMITS.maxDimension || info.height > MEDIA_LIMITS.maxDimension) {
    throw new Error(`Image must be at most ${MEDIA_LIMITS.maxDimension}px on each side`);
  }
  return info;
}
