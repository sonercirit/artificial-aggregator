/**
 * Cache public read data, not rendered pages (which depend on theme cookies).
 * Workers Cache API storage is per data center and best-effort; D1 remains the
 * source of truth. Version the namespace when cached row shapes change.
 */
import { sha256Hex } from "./storage";

const CACHE_ORIGIN = "https://artificialaggregator.com";
const CACHE_VERSION = "d1-reads-v1";
const pending = new Map<string, Promise<unknown>>();

export async function cachedRead<T>(
  key: unknown[],
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  // Node tests and other runtimes need not provide the Workers Cache API.
  if (typeof caches === "undefined") return load();

  const url = `${CACHE_ORIGIN}/__internal/${CACHE_VERSION}/${await sha256Hex(JSON.stringify(key))}`;
  const existing = pending.get(url);
  if (existing) return existing as Promise<T>;

  const result = readThrough(url, ttlSeconds, load);
  pending.set(url, result);
  try {
    return await result;
  } finally {
    pending.delete(url);
  }
}

async function readThrough<T>(url: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE_VERSION);
    const hit = await cache.match(url);
    if (hit) return (await hit.json()) as T;
  } catch (error) {
    console.warn("Read cache unavailable", error);
  }

  // Never cache failures or retry a failed D1 read as a cache fallback.
  const value = await load();
  try {
    await cache?.put(
      url,
      Response.json(value, {
        headers: { "cache-control": `public, max-age=${ttlSeconds}` },
      }),
    );
  } catch (error) {
    console.warn("Could not populate read cache", error);
  }
  return value;
}
