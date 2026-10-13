import { ITUNES_PROXY, DEBOUNCE_MS, LS_SEARCH_CACHE, LS_RELEASE_CACHE } from './config.js';
import { escapeHtml } from './utils.js';
import { cacheGet, cacheSet } from './cache.js';
import { showWarning, hideWarning } from './ui.js';

let lastSuggestions = [];
let activeIndex = -1;
let debounceTimer = null;
let jsonpCounter = 0;

export function getLastSuggestions() {
  return lastSuggestions;
}
export function getActiveIndex() {
  return activeIndex;
}

export function jsonp(url, timeoutMs) {
  timeoutMs = timeoutMs || 12000;
  return new Promise((resolve, reject) => {
    const cb = "__jsonp_" + (++jsonpCounter) + "_" + Date.now();
    const script = document.createElement("script");
    const cleanup = () => {
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    };
    window[cb] = (data) => { cleanup(); resolve(data); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Таймаут")); }, timeoutMs);
    script.onerror = () => { cleanup(); reject(new Error("Ошибка загрузки")); };
    script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
    document.head.appendChild(script);
  });
}

export async function spotifyFetch(path) {
  const target = "https://api.spotify.com/v1" + path;
  const res = await fetch(ITUNES_PROXY + "?u=" + encodeURIComponent(target));
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Spotify HTTP " + res.status + ": " + text.slice(0, 120));
  }
  return res.json();
}

export async function spotifySearchAlbums(query, limit) {
  limit = limit || 20;
  const data = await spotifyFetch(
    "/search?q=" + encodeURIComponent(query) + "&type=album"
  );
  const items = (data.albums && data.albums.items) || [];
  return items.slice(0, Math.max(1, Math.min(50, limit)));
}

export async function spotifyGetAlbum(id) {
  return spotifyFetch("/albums/" + id);
}

export function mapSpotifyAlbum(a) {
  const artistNames = (a.artists || []).map(x => x.name).join(", ");
  const rawCover = (a.images && a.images[0] && a.images[0].url) ||
                   (a.images && a.images[1] && a.images[1].url) || "";
  const cover = rawCover
    ? ITUNES_PROXY + "?u=" + encodeURIComponent(rawCover)
    : "";
  const year = (a.release_date || "").slice(0, 4);
  return {
    id: a.id,
    title: a.name,
    artist: artistNames,
    cover: cover,
    year: year,
    source: "spotify",
    trackCount: a.total_tracks || 0,
    isSingle: (a.album_type === "single") || (a.total_tracks === 1)
  };
}

export function onSearchInput(onChoose) {
  const q = document.getElementById("searchInput").value.trim();
  clearTimeout(debounceTimer);
  if (q.length < 2) { lastSuggestions = []; activeIndex = -1; closeSuggestions(); return; }
  renderSkeletonSuggestions();
  debounceTimer = setTimeout(() => fetchSuggestions(q, onChoose), DEBOUNCE_MS);
}

function renderSkeletonSuggestions() {
  const list = document.getElementById("suggestionList");
  list.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const el = document.createElement("div");
    el.className = "suggestion-skeleton";
    el.innerHTML = '<div class="sk-cover"></div><div class="sk-text"><div class="sk-line"></div><div class="sk-line short"></div></div>';
    list.appendChild(el);
  }
  list.classList.add("open");
}

async function fetchSuggestions(q, onChoose) {
  try {
    const cacheKey = "spotify|" + q.toLowerCase();
    const cached = cacheGet(LS_SEARCH_CACHE, cacheKey);
    if (cached && cached.length) {
      lastSuggestions = cached.slice(0, 20);
      activeIndex = -1;
      renderSuggestions(onChoose);
      return;
    }
    const albums = await spotifySearchAlbums(q, 20);
    const items = albums.map(mapSpotifyAlbum);
    if (items.length === 0) {
      lastSuggestions = [];
      renderStatus("Ничего не найдено");
      return;
    }
    cacheSet(LS_SEARCH_CACHE, cacheKey, items);
    lastSuggestions = items.slice(0, 20);
    activeIndex = -1;
    renderSuggestions(onChoose);
    hideWarning();
  } catch (e) {
    console.error("Spotify search error:", e);
    lastSuggestions = [];
    renderStatus("Ошибка поиска");
    showWarning("🎧 Spotify: " + e.message);
  }
}

function renderSuggestions(onChoose) {
  const list = document.getElementById("suggestionList");
  list.innerHTML = "";
  lastSuggestions.forEach((album, i) => {
    const el = document.createElement("div");
    el.className = "suggestion" + (i === activeIndex ? " active" : "");
    el.dataset.index = i;
    el.innerHTML = '<img src="' + escapeHtml(album.cover) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="text"><div class="t">' + escapeHtml(album.title) + '</div><div class="a">' + escapeHtml(album.artist) + '</div></div>';
    el.onmousedown = (e) => { e.preventDefault(); chooseSuggestion(i, onChoose); };
    el.onmouseenter = () => { activeIndex = i; updateActiveHighlight(); };
    list.appendChild(el);
  });
  list.classList.add("open");
}

function renderStatus(text, withSpinner) {
  const list = document.getElementById("suggestionList");
  list.innerHTML = '<div class="status">' + (withSpinner ? '<span class="spinner"></span>' : "") + escapeHtml(text) + '</div>';
  list.classList.add("open");
}

export function showSuggestions() { if (lastSuggestions.length) document.getElementById("suggestionList").classList.add("open"); }
export function closeSuggestions() { document.getElementById("suggestionList").classList.remove("open"); }

export function updateActiveHighlight() {
  document.querySelectorAll("#suggestionList .suggestion").forEach(el => {
    el.classList.toggle("active", parseInt(el.dataset.index) === activeIndex);
  });
  const active = document.querySelector("#suggestionList .suggestion.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

export function onSearchKeydown(e, onChoose) {
  const isOpen = document.getElementById("suggestionList").classList.contains("open");
  if (e.key === "ArrowDown") {
    if (!lastSuggestions.length) return;
    e.preventDefault();
    if (!isOpen) { showSuggestions(); return; }
    activeIndex = (activeIndex + 1) % lastSuggestions.length;
    updateActiveHighlight();
  } else if (e.key === "ArrowUp") {
    if (!lastSuggestions.length || !isOpen) return;
    e.preventDefault();
    activeIndex = (activeIndex - 1 + lastSuggestions.length) % lastSuggestions.length;
    updateActiveHighlight();
  } else if (e.key === "Tab") {
    if (!lastSuggestions.length || !isOpen) return;
    e.preventDefault();
    if (e.shiftKey) activeIndex = (activeIndex - 1 + lastSuggestions.length) % lastSuggestions.length;
    else activeIndex = (activeIndex + 1) % lastSuggestions.length;
    updateActiveHighlight();
  } else if (e.key === "Enter") {
    if (isOpen && activeIndex >= 0 && lastSuggestions[activeIndex]) { e.preventDefault(); chooseSuggestion(activeIndex, onChoose); }
    else if (lastSuggestions.length > 0) { e.preventDefault(); chooseSuggestion(0, onChoose); }
  } else if (e.key === "Escape") {
    closeSuggestions();
  }
}

export function chooseSuggestion(i, onChoose) {
  const album = lastSuggestions[i];
  if (!album) return;
  closeSuggestions();
  document.getElementById("searchInput").value = album.title + " — " + album.artist;
  lastSuggestions = [];
  activeIndex = -1;
  if (onChoose) onChoose({ id: album.id, title: album.title, cover: album.cover, source: "spotify" });
}

export function resetSearchState() {
  lastSuggestions = [];
  activeIndex = -1;
  clearTimeout(debounceTimer);
}