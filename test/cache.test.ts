import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedRead } from "../src/lib/cache";
import { installReadCache } from "./helpers/cache";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("D1 read cache", () => {
  it("reuses data until expiry and keeps query parameters separate", async () => {
    const { advance } = installReadCache();
    const load = vi.fn(async () => [{ id: 1 }]);
    expect(await cachedRead(["rows", 1], 60, load)).toEqual([{ id: 1 }]);
    expect(await cachedRead(["rows", 1], 60, load)).toEqual([{ id: 1 }]);
    expect(load).toHaveBeenCalledTimes(1);
    await cachedRead(["rows", 2], 60, load);
    expect(load).toHaveBeenCalledTimes(2);
    advance(60);
    await cachedRead(["rows", 1], 60, load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("coalesces simultaneous cache misses", async () => {
    installReadCache();
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [1];
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cachedRead(["concurrent"], 60, load)),
    );
    expect(results).toEqual(Array.from({ length: 10 }, () => [1]));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache errors or strand an in-flight promise", async () => {
    const { cache } = installReadCache();
    const load = vi.fn().mockRejectedValueOnce(new Error("D1 quota")).mockResolvedValue([1]);
    await expect(cachedRead(["failure"], 60, load)).rejects.toThrow("D1 quota");
    expect(cache.put).not.toHaveBeenCalled();
    expect(await cachedRead(["failure"], 60, load)).toEqual([1]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("falls back to D1 once if cache reads and writes fail", async () => {
    const { cache } = installReadCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cache.match.mockRejectedValue(new Error("cache unavailable"));
    cache.put.mockRejectedValue(new Error("cache unavailable"));
    const load = vi.fn(async () => [1]);
    expect(await cachedRead(["fallback"], 60, load)).toEqual([1]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("works without the Workers Cache API", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await cachedRead(["node"], 60, async () => [1])).toEqual([1]);
  });
});
