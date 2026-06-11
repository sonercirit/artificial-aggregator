/**
 * Hashing and the gzip/base64 chunk codec used to fit multi-megabyte raw
 * HTML snapshots into D1 text rows.
 */

const textEncoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function gzipStringToBase64Chunks(
  value: string,
  chunkChars = 256 * 1024,
): Promise<{ chunks: string[]; gzipBytes: number; originalBytes: number }> {
  const original = textEncoder.encode(value);
  const stream = new Response(toArrayBuffer(original)).body?.pipeThrough(
    new CompressionStream("gzip"),
  );

  if (!stream) {
    throw new Error("CompressionStream is unavailable in this runtime");
  }

  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const base64 = bytesToBase64(compressed);
  const chunks: string[] = [];

  for (let i = 0; i < base64.length; i += chunkChars) {
    chunks.push(base64.slice(i, i + chunkChars));
  }

  return {
    chunks,
    gzipBytes: compressed.byteLength,
    originalBytes: original.byteLength,
  };
}

export async function gunzipBase64ChunksToString(chunks: string[]): Promise<string> {
  const compressed = base64ToBytes(chunks.join(""));
  const stream = new Response(toArrayBuffer(compressed)).body?.pipeThrough(
    new DecompressionStream("gzip"),
  );

  if (!stream) {
    throw new Error("DecompressionStream is unavailable in this runtime");
  }

  return new Response(stream).text();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 0x8000;

  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode(...bytes.subarray(i, i + stride));
  }

  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
