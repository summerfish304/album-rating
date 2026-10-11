import { LS_SEARCH_CACHE, LS_RELEASE_CACHE, SEARCH_CACHE_TTL, RELEASE_CACHE_TTL } from './config.js';

export function cacheGet(cacheKey, key) {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const item = obj[key];
    if (!item) return null;
    const ttl = cacheKey === LS_SEARCH_CACHE ? SEARCH_CACHE_TTL : RELEASE_CACHE_TTL;
    if (Date.now() - item.ts > ttl) return null;
    return item.data;
  } catch (e) { return null; }
}
export function cacheSet(cacheKey, key, data) {
  try {
    const raw = localStorage.getItem(cacheKey);
    const obj = raw ? JSON.parse(raw) : {};
    obj[key] = { ts: Date.now(), data };
    const ttl = cacheKey === LS_SEARCH_CACHE ? SEARCH_CACHE_TTL : RELEASE_CACHE_TTL;
    const now = Date.now();
    Object.keys(obj).forEach(k => { if (now - obj[k].ts > ttl) delete obj[k]; });
    localStorage.setItem(cacheKey, JSON.stringify(obj));
  } catch (e) {}
}

// ---------- COVER CACHE ----------
export const IMG_CACHE_NAME = "albumRating-covers-v1";
export async function getCoverCache() {
  if (!("caches" in window)) return null;
  try { return await caches.open(IMG_CACHE_NAME); } catch (e) { return null; }
}
export async function cacheCover(url) {
  if (!url || !/^https?:/.test(url)) return;
  const cache = await getCoverCache();
  if (!cache) return;
  try {
    const hit = await cache.match(url);
    if (hit) return;
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (res && res.ok) await cache.put(url, res.clone());
  } catch (e) {}
}
export async function getCachedCoverBlob(url) {
  if (!url || !/^https?:/.test(url)) return null;
  const cache = await getCoverCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(url);
    if (!hit || !hit.ok) return null;
    const blob = await hit.blob();
    if (!blob || blob.size === 0) return null;
    return blob;
  } catch (e) { return null; }
}
export function scheduleCoverCaching(urls) {
  if (!urls || !urls.length) return;
  const unique = Array.from(new Set(urls.filter(Boolean)));
  let i = 0;
  const step = () => {
    if (i >= unique.length) return;
    cacheCover(unique[i++]).finally(() => {
      if (i % 3 === 0) setTimeout(step, 120);
      else step();
    });
  };
  setTimeout(step, 300);
}
export async function hydrateImagesFromCache(rootEl) {
  rootEl = rootEl || document;
  const imgs = Array.from(rootEl.querySelectorAll("img[data-cacheable]"));
  if (!imgs.length) return;
  for (const img of imgs) {
    if (img.dataset.cacheHydrated) continue;
    img.dataset.cacheHydrated = "1";
    const url = img.dataset.src || img.src;
    const blob = await getCachedCoverBlob(url);
    if (blob) {
      try {
        const objUrl = URL.createObjectURL(blob);
        img.src = objUrl;
        img.addEventListener("load", () => URL.revokeObjectURL(objUrl), { once: true });
      } catch (e) {}
    }
  }
}