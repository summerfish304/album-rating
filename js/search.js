import { ITUNES_PROXY, DEBOUNCE_MS, LS_SEARCH_CACHE, LS_RELEASE_CACHE } from './config.js';
import { escapeHtml } from './utils.js';
import { mapSpotifyArtist, mapSpotifyArtistAlbum } from './artists.js';
import { cacheGet, cacheSet } from './cache.js';
import { showWarning, hideWarning, showToast } from './ui.js';

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
  // Фильтр: без компиляций и мульти-артистов
  const filtered = items.filter(a =>
    a.album_type !== "compilation" &&
    (a.artists || []).length === 1 &&
    !/various/i.test(a.artists?.[0]?.name || "")
  );
  return filtered.slice(0, Math.max(1, Math.min(50, limit)));
}

// ============================================================
// ЕДИНЫЙ ПОИСК: альбомы + артисты
// ============================================================
export async function searchAll(query, limit) {
  limit = limit || 25;
  const data = await spotifyFetch(
    "/search?q=" + encodeURIComponent(query) + "&type=album,artist"
  );

  const albumsRaw = (data.albums && data.albums.items) || [];
  const artistsRaw = (data.artists && data.artists.items) || [];

  const albums = albumsRaw
    .filter(a => a.album_type !== "compilation")
    .filter(a => (a.artists || []).length === 1)
    .filter(a => !/various|v\.a\.|сборник/i.test((a.artists?.[0]?.name || "")))
    .filter(a => !/^(top|best|greatest|hits|collection|playlist|compilation|хіт|лучшие|сборник|now that)/i.test(a.name || ""))
    .filter(a => !/\b(hits|antolog|anthology|collection|compilation)\b/i.test(a.name || ""))
    .map(mapSpotifyAlbum)
    .map(a => ({
      kind: "release",
      ...a
    }));

  const artists = artistsRaw.map(mapSpotifyArtist).map(a => ({
    kind: "artist",
    id: a.id,
    title: a.name,
    cover: a.photo,
    artist: (a.genres && a.genres.length ? a.genres.slice(0, 2).join(", ") : "Артист"),
    source: "spotify",
    followers: a.followers,
    genres: a.genres
  }));

  // Смешиваем: сначала пара артистов (для клика на страницу),
  // потом релизы. Или всё подряд с сохранением порядка поиска.
  // Простой вариант: артисты + релизы, чередуя в начале.
  const mixed = [];
  const maxLen = Math.max(artists.length, albums.length);
  for (let i = 0; i < maxLen; i++) {
    if (artists[i]) mixed.push(artists[i]);
    if (albums[i]) mixed.push(albums[i]);
    if (mixed.length >= limit) break;
  }
  return mixed.slice(0, limit);
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

export function onSearchInput(onChoose, onChooseArtist) {
  const q = document.getElementById("searchInput").value.trim();
  clearTimeout(debounceTimer);
  if (q.length < 2) { lastSuggestions = []; activeIndex = -1; closeSuggestions(); return; }
  renderSkeletonSuggestions();
  debounceTimer = setTimeout(() => fetchSuggestions(q, onChoose, onChooseArtist), DEBOUNCE_MS);
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

async function fetchSuggestions(q, onChoose, onChooseArtist) {
  try {
    const cacheKey = "spotify_all|" + q.toLowerCase();
    const cached = cacheGet(LS_SEARCH_CACHE, cacheKey);
    if (cached && cached.length) {
      lastSuggestions = cached.slice(0, 25);
      activeIndex = -1;
      renderSuggestions(onChoose, onChooseArtist);
      return;
    }
    const items = await searchAll(q, 25);
    if (items.length === 0) {
      lastSuggestions = [];
      renderStatus("Ничего не найдено");
      return;
    }
    cacheSet(LS_SEARCH_CACHE, cacheKey, items);
    lastSuggestions = items.slice(0, 25);
    activeIndex = -1;
    renderSuggestions(onChoose, onChooseArtist);
    hideWarning();
  } catch (e) {
    console.error("Spotify search error:", e);
    lastSuggestions = [];
    renderStatus("Ошибка поиска");
    showWarning("🎧 Spotify: " + e.message);
  }
}

function renderSuggestions(onChoose, onChooseArtist) {
  const list = document.getElementById("suggestionList");
  list.innerHTML = "";
  lastSuggestions.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "suggestion" + (i === activeIndex ? " active" : "") + (item.kind === "artist" ? " suggestion-artist" : "");
    el.dataset.index = i;
    if (item.kind === "artist") {
      el.innerHTML =
        (item.cover
          ? '<img class="suggestion-artist-img" src="' + escapeHtml(item.cover) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
          : '<div class="suggestion-artist-noimg">🎤</div>') +
        '<div class="text">' +
          '<div class="t">' + escapeHtml(item.title) + '</div>' +
          '<div class="a">🎤 ' + escapeHtml(item.artist || "Артист") + '</div>' +
        '</div>' +
        '<div class="suggestion-badge">Артист</div>';
    } else {
      el.innerHTML =
        '<img src="' + escapeHtml(item.cover) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="text">' +
          '<div class="t">' + escapeHtml(item.title) + '</div>' +
          '<div class="a">💿 ' + escapeHtml(item.artist) + (item.year ? ' · ' + item.year : '') + '</div>' +
        '</div>';
    }
    el.onmousedown = (e) => { e.preventDefault(); chooseSuggestion(i, onChoose, onChooseArtist); };
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

export function onSearchKeydown(e, onChoose, onChooseArtist) {
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
    if (isOpen && activeIndex >= 0 && lastSuggestions[activeIndex]) { e.preventDefault(); chooseSuggestion(activeIndex, onChoose, onChooseArtist); }
    else if (lastSuggestions.length > 0) { e.preventDefault(); chooseSuggestion(0, onChoose, onChooseArtist); }
  } else if (e.key === "Escape") {
    closeSuggestions();
  }
}

export function chooseSuggestion(i, onChoose, onChooseArtist) {
  const item = lastSuggestions[i];
  if (!item) return;
  closeSuggestions();

  if (item.kind === "artist") {
    document.getElementById("searchInput").value = "🎤 " + item.title;
    addToSearchHistory(item.title, "artist");
    lastSuggestions = [];
    activeIndex = -1;
    if (onChooseArtist) onChooseArtist(item.id);
    return;
  }

  // Релиз
  document.getElementById("searchInput").value = item.title + " — " + item.artist;
  addToSearchHistory(item.title + " " + item.artist, "release");
  lastSuggestions = [];
  activeIndex = -1;
  if (onChoose) onChoose({ id: item.id, title: item.title, cover: item.cover, source: "spotify" });
}

// ============================================================
// ИСТОРИЯ ПОИСКА
// ============================================================
export function getSearchHistory() {
  try {
    const raw = localStorage.getItem("albumRating_searchHistory_v1");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

export function addToSearchHistory(query, kind) {
  if (!query || query.trim().length < 2) return;
  const q = query.trim();
  try {
    let arr = getSearchHistory();
    // Убираем дубли
    arr = arr.filter(item => item.q.toLowerCase() !== q.toLowerCase());
    // Добавляем в начало
    arr.unshift({ q: q, kind: kind || "all", ts: Date.now() });
    // Обрезаем до 10
    arr = arr.slice(0, 10);
    localStorage.setItem("albumRating_searchHistory_v1", JSON.stringify(arr));
    renderSearchHistory();
  } catch (e) {}
}

export function clearSearchHistory() {
  try { localStorage.removeItem("albumRating_searchHistory_v1"); } catch (e) {}
  renderSearchHistory();
}

export function renderSearchHistory() {
  const block = document.getElementById("searchHistoryBlock");
  const list = document.getElementById("searchHistoryList");
  if (!block || !list) return;

  const history = getSearchHistory();
  if (history.length === 0) {
    block.classList.add("hidden");
    return;
  }

  block.classList.remove("hidden");
  list.innerHTML = "";
  history.forEach(item => {
    const btn = document.createElement("button");
    btn.className = "search-history-chip";
    btn.innerHTML = '<span class="shc-icon">🔍</span><span class="shc-text">' + escapeHtml(item.q) + '</span>';
    btn.onclick = () => {
      const inp = document.getElementById("searchInput");
      if (inp) {
        inp.value = item.q;
        // Триггерим поиск
        const evt = new Event("input", { bubbles: true });
        inp.dispatchEvent(evt);
        inp.focus();
      }
    };
    list.appendChild(btn);
  });
}

// ============================================================
// ИЗБРАННОЕ
// ============================================================
import { db, collection, doc, setDoc, getDoc, getDocs, deleteDoc, query, where, serverTimestamp } from './firebase.js';

let currentUserFav = null;

export function setSearchContext(opts) {
  if (opts.currentUser !== undefined) currentUserFav = opts.currentUser;
}

// Загрузить избранное юзера
export async function loadFavorites() {
  if (!currentUserFav) return [];
  try {
    const q = query(collection(db, "favorites"), where("uid", "==", currentUserFav.uid));
    const snap = await getDocs(q);
    const items = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    items.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
    return items;
  } catch (e) { return []; }
}

// Добавить в избранное
export async function addToFavorites(item) {
  if (!currentUserFav) { showToast("Нужно войти"); return; }
  if (!item || !item.id || !item.kind) return;

  const docId = currentUserFav.uid + "_" + item.kind + "_" + item.id;
  try {
    const existing = await getDoc(doc(db, "favorites", docId));
    if (existing.exists()) { showToast("Уже в избранном"); return; }

    await setDoc(doc(db, "favorites", docId), {
      uid: currentUserFav.uid,
      kind: item.kind,           // "release" | "artist"
      itemId: item.id,
      title: item.title || "",
      artist: item.artist || "",
      cover: item.cover || "",
      genres: item.genres || [],
      ts: serverTimestamp()
    });
    showToast("Добавлено в избранное", { success: true });
    renderFavorites();
  } catch (e) {
    showToast("Ошибка: " + e.message);
  }
}

// Удалить из избранного
export async function removeFromFavorites(favId) {
  try {
    await deleteDoc(doc(db, "favorites", favId));
    showToast("Удалено из избранного");
    renderFavorites();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// Проверить, в избранном ли
export async function isFavorite(kind, itemId) {
  if (!currentUserFav) return false;
  const docId = currentUserFav.uid + "_" + kind + "_" + itemId;
  try {
    const snap = await getDoc(doc(db, "favorites", docId));
    return snap.exists();
  } catch (e) { return false; }
}

// Рендер избранного
export async function renderFavorites() {
  const block = document.getElementById("favoritesBlock");
  const list = document.getElementById("favoritesList");
  if (!block || !list) return;
  if (!currentUserFav) { block.classList.add("hidden"); return; }

  const items = await loadFavorites();
  if (items.length === 0) {
    block.classList.add("hidden");
    return;
  }

  block.classList.remove("hidden");
  list.innerHTML = "";
  items.forEach(fav => {
    const el = document.createElement("div");
    el.className = "favorites-item";
    const icon = fav.kind === "artist" ? "🎤" : "💿";
    el.innerHTML =
      (fav.cover
        ? '<img class="fav-cover" src="' + escapeHtml(fav.cover) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="fav-cover fav-noimg">' + icon + '</div>') +
      '<div class="fav-info">' +
        '<div class="fav-title">' + escapeHtml(fav.title) + '</div>' +
        '<div class="fav-sub">' + icon + ' ' + escapeHtml(fav.artist || "") + '</div>' +
      '</div>' +
      '<button class="fav-del" title="Убрать из избранного">✕</button>';
    el.onclick = (e) => {
      if (e.target.classList.contains("fav-del")) return;
      if (fav.kind === "artist") {
        if (window.openArtist) window.openArtist(fav.itemId);
      } else {
        if (window.openBoardModal) {
          // Открываем через доску, если релиз есть; иначе — оценка
          const group = (window._boardData && window._boardData()) ? window._boardData().find(b => b.releaseId === fav.itemId) : null;
          if (group) {
            window.switchNav("board");
            setTimeout(() => window.openBoardModal(group), 250);
          } else if (window.switchNav) {
            window.switchNav("main");
            if (window._loadAlbum) window._loadAlbum({ id: fav.itemId, title: "", cover: "", source: "spotify" });
          }
        }
      }
    };
    el.querySelector(".fav-del").onclick = (e) => {
      e.stopPropagation();
      removeFromFavorites(fav._id);
    };
    list.appendChild(el);
  });
}

// Свернуть/развернуть блок избранного
export function toggleFavoritesCollapse() {
  const list = document.getElementById("favoritesList");
  const btn = document.getElementById("favoritesToggleBtn");
  if (!list || !btn) return;
  const collapsed = list.classList.toggle("collapsed");
  btn.textContent = collapsed ? "Развернуть" : "Свернуть";
}

export function resetSearchState() {
  lastSuggestions = [];
  activeIndex = -1;
  clearTimeout(debounceTimer);
}