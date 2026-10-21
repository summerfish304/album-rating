// ============================================================
// recommendations.js — рекомендации на главной (v3, с кэшем)
// ============================================================

import { db, collection, getDocs } from './firebase.js';
import { escapeHtml } from './utils.js';
import { showToast } from './ui.js';

let currentUser = null;
let userProfile = null;
let callbacks = {};

// ============================================================
// КОНСТАНТЫ
// ============================================================
const RECO_CACHE_KEY = "albumRating_recoCache_v1";
const RECO_CACHE_TTL = 15 * 60 * 1000;   // 15 минут
const REFRESH_COOLDOWN = 5000;            // 5 сек между кликами
const SPOTIFY_429_COOLDOWN = 60 * 1000;   // 1 минута после 429

// ============================================================
// СОСТОЯНИЕ
// ============================================================
let _lastRefresh = 0;                     // timestamp последнего refresh
let _spotifyCooldown = 0;                 // до какого времени Spotify "отдыхает"
let _isRefreshing = false;                // защита от параллельных запросов

export function setRecommendationsContext(opts) {
  if (opts.currentUser !== undefined) currentUser = opts.currentUser;
  if (opts.userProfile !== undefined) userProfile = opts.userProfile;
  if (opts.callbacks !== undefined) callbacks = opts.callbacks || {};
}

// ============================================================
// КЭШ
// ============================================================
function loadCache() {
  try {
    const raw = localStorage.getItem(RECO_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts) return null;
    if (Date.now() - parsed.ts > RECO_CACHE_TTL) return null;
    return parsed.data;
  } catch (e) { return null; }
}

function saveCache(data) {
  try {
    localStorage.setItem(RECO_CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      data: data
    }));
  } catch (e) {}
}

function clearCache() {
  try { localStorage.removeItem(RECO_CACHE_KEY); } catch (e) {}
}

// ============================================================
// SPOTIFY FETCH (с обработкой 429)
// ============================================================
import { ITUNES_PROXY } from './config.js';

async function spotifyFetch(path) {
  // Проверяем cooldown после 429
  if (Date.now() < _spotifyCooldown) {
    throw new Error("SPOTIFY_COOLDOWN");
  }

  const target = "https://api.spotify.com/v1" + path;
  const res = await fetch(ITUNES_PROXY + "?u=" + encodeURIComponent(target));

  if (res.status === 429) {
    // Spotify сказал "слишком много"
    _spotifyCooldown = Date.now() + SPOTIFY_429_COOLDOWN;
    // Пытаемся получить Retry-After (в секундах)
    const retryAfter = parseInt(res.headers.get("Retry-After") || "60");
    _spotifyCooldown = Date.now() + Math.max(retryAfter * 1000, SPOTIFY_429_COOLDOWN);
    throw new Error("SPOTIFY_429");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Spotify HTTP " + res.status + ": " + text.slice(0, 120));
  }
  return res.json();
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ
// ============================================================
function parseDate(releaseDateStr) {
  if (!releaseDateStr) return 0;
  const parts = releaseDateStr.split("-");
  const year = parseInt(parts[0]);
  const month = parts[1] ? parseInt(parts[1]) - 1 : 0;
  const day = parts[2] ? parseInt(parts[2]) : 1;
  const t = new Date(year, month, day).getTime();
  return isNaN(t) ? 0 : t;
}

async function loadAllRatingsGrouped() {
  try {
    const snap = await getDocs(collection(db, "ratings"));
    const all = snap.docs.map(d => d.data()).filter(r => !r.hidden && r.album);
    const byRelease = {};
    all.forEach(r => {
      const key = r.source + "_" + r.releaseId;
      if (!byRelease[key]) {
        byRelease[key] = {
          id: r.releaseId,
          source: r.source,
          album: r.album,
          ratings: [],
          lastTs: 0
        };
      }
      byRelease[key].ratings.push(r);
      const ts = r.ts?.seconds || 0;
      if (ts > byRelease[key].lastTs) byRelease[key].lastTs = ts;
    });
    return Object.values(byRelease);
  } catch (e) {
    console.warn("Ratings load error:", e.message);
    return [];
  }
}

// ============================================================
// ИСТОЧНИКИ
// ============================================================

async function getTrending(groups) {
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;
  return groups
    .map(g => ({ ...g, recentCount: g.ratings.filter(r => (r.ts?.seconds || 0) >= weekAgo).length }))
    .filter(g => g.recentCount > 0)
    .sort((a, b) => b.recentCount - a.recentCount)
    .slice(0, 10)
    .map(g => ({
      id: g.id, source: g.source,
      title: g.album.title, artist: g.album.artist,
      cover: g.album.artwork, year: (g.album.releaseDate || "").slice(0, 4),
      count: g.recentCount
    }));
}

async function getNewReleases(groups) {
  const thisYear = new Date().getFullYear();
  return groups
    .filter(g => {
      const ms = parseDate(g.album.releaseDate);
      if (!ms) return false;
      const y = new Date(ms).getFullYear();
      return y === thisYear || y === thisYear - 1;
    })
    .sort((a, b) => parseDate(b.album.releaseDate) - parseDate(a.album.releaseDate))
    .slice(0, 10)
    .map(g => ({
      id: g.id, source: g.source,
      title: g.album.title, artist: g.album.artist,
      cover: g.album.artwork, year: (g.album.releaseDate || "").slice(0, 4),
      count: g.ratings.length
    }));
}

async function getPopularOnSite(groups) {
  return [...groups]
    .sort((a, b) => b.ratings.length - a.ratings.length)
    .slice(0, 10)
    .map(g => ({
      id: g.id, source: g.source,
      title: g.album.title, artist: g.album.artist,
      cover: g.album.artwork, year: (g.album.releaseDate || "").slice(0, 4),
      count: g.ratings.length
    }));
}

async function getRandomFromBase(groups) {
  if (groups.length === 0) return [];
  return [...groups].sort(() => Math.random() - 0.5).slice(0, 5).map(g => ({
    id: g.id, source: g.source,
    title: g.album.title, artist: g.album.artist,
    cover: g.album.artwork, year: (g.album.releaseDate || "").slice(0, 4),
    count: g.ratings.length
  }));
}

async function getPersonalRecommendations() {
  if (!currentUser) return [];
  try {
    const snap = await getDocs(collection(db, "ratings"));
    const all = snap.docs.map(d => d.data()).filter(r => !r.hidden && r.album);
    const myRatings = all.filter(r => r.uid === currentUser.uid);
    if (myRatings.length === 0) return [];

    const artistCount = {};
    myRatings.forEach(r => {
      const a = r.album.artist;
      if (a) artistCount[a] = (artistCount[a] || 0) + 1;
    });
    const favArtists = Object.entries(artistCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(e => e[0]);
    if (favArtists.length === 0) return [];

    const ratedKeys = new Set(myRatings.map(r => r.source + "_" + r.releaseId));
    const byRelease = {};
    all.forEach(r => {
      const key = r.source + "_" + r.releaseId;
      if (ratedKeys.has(key)) return;
      if (!favArtists.some(a => r.album.artist && r.album.artist.includes(a))) return;
      if (!byRelease[key]) {
        byRelease[key] = { id: r.releaseId, source: r.source, album: r.album, count: 0 };
      }
      byRelease[key].count++;
    });

    return Object.values(byRelease)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(g => ({
        id: g.id, source: g.source,
        title: g.album.title, artist: g.album.artist,
        cover: g.album.artwork, year: (g.album.releaseDate || "").slice(0, 4),
        count: g.count
      }));
  } catch (e) {
    console.warn("Personal reco error:", e.message);
    return [];
  }
}

// ============================================================
// РЕНДЕР
// ============================================================
function renderRecoBlock(blockId, listId, items) {
  const block = document.getElementById(blockId);
  const list = document.getElementById(listId);
  if (!block || !list) return;
  if (!items || items.length === 0) {
    block.classList.add("hidden");
    return;
  }
  block.classList.remove("hidden");
  list.innerHTML = "";
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "reco-card";
    card.innerHTML =
      '<div class="reco-card-cover-wrap">' +
        (item.cover
          ? '<img class="reco-card-cover" src="' + escapeHtml(item.cover) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">'
          : '<div class="reco-card-cover reco-noimg">💿</div>') +
        (item.count > 1 ? '<div class="reco-card-count">⭐ ' + item.count + '</div>' : '') +
      '</div>' +
      '<div class="reco-card-info">' +
        '<div class="reco-card-title">' + escapeHtml(item.title) + '</div>' +
        '<div class="reco-card-artist">' + escapeHtml(item.artist) + '</div>' +
      '</div>';

    card.onclick = () => {
      if (callbacks.onLoadAlbum) {
        callbacks.onLoadAlbum({ id: item.id, title: item.title, cover: item.cover, source: item.source || "spotify" });
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    };
    list.appendChild(card);
  });
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ
// ============================================================
export async function loadRecommendations(forceRefresh) {
  // Защита от параллельных вызовов
  if (_isRefreshing) return;

  // Проверяем кэш (если не forceRefresh)
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached) {
      renderAllFromData(cached);
      return;
    }
  }

  _isRefreshing = true;
  try {
    // Загружаем данные из Firestore (это не Spotify, кэш не нужен)
    const groups = await loadAllRatingsGrouped();

    // Считаем все рекомендации
    const data = {
      trending: await getTrending(groups),
      fresh: await getNewReleases(groups),
      popular: await getPopularOnSite(groups),
      random: await getRandomFromBase(groups),
      personal: await getPersonalRecommendations()
    };

    // Сохраняем в кэш
    saveCache(data);

    // Рисуем
    renderAllFromData(data);
  } catch (e) {
    console.warn("Recommendations error:", e);
    // Пробуем показать кэш, даже если он старый
    const cached = loadCache();
    if (cached) {
      renderAllFromData(cached);
    }
  } finally {
    _isRefreshing = false;
  }
}

function renderAllFromData(data) {
  renderRecoBlock("recoTrending", "recoTrendingList", data.trending);
  renderRecoBlock("recoNew", "recoNewList", data.fresh);
  renderRecoBlock("recoPopular", "recoPopularList", data.popular);
  renderRecoBlock("recoRandom", "recoRandomList", data.random);
  renderRecoBlock("recoPersonal", "recoPersonalList", data.personal);
}

// ============================================================
// ОБНОВЛЕНИЕ (с защитой от спама)
// ============================================================
export async function refreshRecommendations() {
  // Проверка cooldown после 429
  if (Date.now() < _spotifyCooldown) {
    const sec = Math.ceil((_spotifyCooldown - Date.now()) / 1000);
    showToast("Спотифай отдыхает. Подождите " + sec + " сек", { gold: true });
    return;
  }

  // Проверка "заморозки" кнопки
  const now = Date.now();
  if (now - _lastRefresh < REFRESH_COOLDOWN) {
    const sec = Math.ceil((REFRESH_COOLDOWN - (now - _lastRefresh)) / 1000);
    showToast("Подождите " + sec + " сек", { gold: true });
    return;
  }
  _lastRefresh = now;

  // Сбрасываем кэш (только при refresh)
  clearCache();

  // Загружаем заново, принудительно
  await loadRecommendations(true);
  showToast("Обновлено");
}

export async function refreshRandomReco() {
  const groups = await loadAllRatingsGrouped();
  const random = await getRandomFromBase(groups);
  renderRecoBlock("recoRandom", "recoRandomList", random);
}

export function setRecommendationsVisible(visible) {
  const section = document.getElementById("recommendationsSection");
  if (!section) return;
  if (visible) section.classList.remove("hidden");
  else section.classList.add("hidden");
}

// Экспорт в window
if (typeof window !== "undefined") {
  window.loadRecommendations = loadRecommendations;
  window.refreshRecommendations = refreshRecommendations;
  window.refreshRandomReco = refreshRandomReco;
}