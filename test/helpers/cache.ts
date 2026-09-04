import { vi } from "vitest";

/** Workers-like cache with explicit time advancement (no fake runtime timers). */
export function installReadCache() {
  let now = 0;
  const entries = new Map<string, { response: Response; expiresAt: number }>();
  const cache = {
    match: vi.fn(async (url: string) => {
      const entry = entries.get(url);
      return entry && entry.expiresAt > now ? entry.response.clone() : undefined;
    }),
    put: vi.fn(async (url: string, response: Response) => {
      const ttl = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1]);
      entries.set(url, { response: response.clone(), expiresAt: now + ttl * 1000 });
    }),
  };
  vi.stubGlobal("caches", { open: async () => cache });
  return { cache, advance: (seconds: number) => (now += seconds * 1000) };
}
