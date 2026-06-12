import { describe, expect, it } from "vitest";
import {
  gunzipBase64ChunksToString,
  gzipStringToBase64Chunks,
  sha256Hex,
} from "../src/lib/storage";

describe("sha256Hex", () => {
  it("matches the known digest for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("gzip/base64 chunk codec", () => {
  it("round-trips unicode content", async () => {
    const input = `<html>héllo wörld ünïcode 🤖 ${"x".repeat(1000)}</html>`;
    const { chunks, gzipBytes, originalBytes } = await gzipStringToBase64Chunks(input);

    expect(chunks.length).toBeGreaterThan(0);
    expect(gzipBytes).toBeGreaterThan(0);
    expect(originalBytes).toBe(new TextEncoder().encode(input).byteLength);
    expect(await gunzipBase64ChunksToString(chunks)).toBe(input);
  });

  it("splits into multiple chunks of at most chunkChars and reassembles them", async () => {
    // Random-ish content resists compression so several chunks are produced.
    const input = Array.from({ length: 5000 }, (_, i) => (Math.sin(i) * 1e9).toString(36)).join(
      "|",
    );
    const { chunks } = await gzipStringToBase64Chunks(input, 1024);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1024);
    }
    expect(await gunzipBase64ChunksToString(chunks)).toBe(input);
  });
});
