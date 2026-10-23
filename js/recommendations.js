// ============================================================
// recommendations.js — рекомендации на главной (v4)
// ============================================================

import { db, collection, getDocs } from './firebase.js';
import { ITUNES_PROXY } from './config.js';
import { escapeHtml } from './utils.js';
import { showToast } from './ui.js';

let currentUser = null;
let userProfile = null;
let callbacks = {};

// ============================================================
// КОНСТАНТЫ
// ============================================================
const RECO_CACHE_KEY = "albumRating_recoCache_v2";
const RECO_CACHE_TTL = 15 * 60 * 1000;   // 15 минут
const REFRESH_COOLDOWN = 5000;            // 5 сек между кликами
const SPOTIFY_429_COOLDOWN = 60 * 1000;   // 1 минута после 429

// ============================================================
// СОСТОЯНИЕ
// ============================================================
let _lastRefresh = 0;
let _spotifyCooldown = 0;
let _isRefreshing = false;

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
// SPOTIFY FETCH (с защитой от 429)
// ============================================================
async function spotifyFetch(path) {
  if (Date.now() < _spotifyCooldown) {
    throw new Error("SPOTIFY_COOLDOWN");
  }

  const target = "https://api.spotify.com/v1" + path;
  const res = await fetch(ITUNES_PROXY + "?u=" + encodeURIComponent(target));

  if (res.status === 429) {
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

function mapSpotifyAlbumToReco(a) {
  const artists = a.artists || [];
  const rawCover = (a.images && a.images[0] && a.images[0].url) ||
                   (a.images && a.images[1] && a.images[1].url) || "";
  const cover = rawCover ? ITUNES_PROXY + "?u=" + encodeURIComponent(rawCover) : "";
  return {
    id: a.id,
    source: "spotify",
    title: a.name,
    artist: artists.map(x => x.name).join(", "),
    cover: cover,
    year: (a.release_date || "").slice(0, 4),
    isSingle: a.album_type === "single",
    _artistsCount: artists.length,
    _isCompilation: a.album_type === "compilation"
  };
}

function isValidSpotifyAlbum(a) {
  if (!a) return false;
  if (a._isCompilation) return false;
  if (a._artistsCount > 1) return false;
  const artistName = (a.artist || "").toLowerCase();
  if (/various|v\.a\.|сборник/i.test(artistName)) return false;
  return true;
}

async function fetchArtistAlbums(artistName, limit) {
  limit = limit || 3;
  try {
    const data = await spotifyFetch("/search?q=" + encodeURIComponent(artistName) + "&type=album");
    const items = (data.albums && data.albums.items) || [];
    const mapped = items.map(mapSpotifyAlbumToReco);
    
    // Жёсткий фильтр: имя артиста должно ТОЧНО начинаться с искомого
    const artistLower = artistName.toLowerCase();
    const filtered = mapped.filter(a => {
      if (!a) return false;
      if (a._isCompilation) return false;
      
      // Разрешаем фиты (несколько артистов) для русских, но не Various Artists
      const mainArtist = (a.artist || "").toLowerCase();
      if (/various|v\.a\.|сборник/i.test(mainArtist)) return false;
      
      // Основной артист должен начинаться с искомого имени
      return mainArtist.startsWith(artistLower) || mainArtist.includes(" " + artistLower);
    });
    
    return filtered.slice(0, limit);
  } catch (e) {
    console.warn("fetchArtistAlbums error for " + artistName + ":", e.message);
    return [];
  }
}

// Загружаем все оценки из Firestore для блоков "Популярное", "Случайное", "Для вас"
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
// ИСТОЧНИКИ ИЗ SPOTIFY (Западные хиты и Русский рэп)
// ============================================================
async function getWesternHits() {
  const westernArtists = [
  "The Weeknd", "Drake", "Travis Scott", "Kendrick Lamar", "Taylor Swift",
  "Billie Eilish", "Post Malone", "Dua Lipa", "Ariana Grande", "Ed Sheeran",
  "Bad Bunny", "SZA", "Doja Cat", "Tyler The Creator", "Kanye West",
  "Playboi Carti", "Future", "Metro Boomin", "21 Savage", "Don Toliver"
  ];
  return await getRecoFromArtists(westernArtists);
}

async function getRussianRap() {
  const ruArtists = [
    "OG Buda", "Mayot", "Баста", "FRIENDLY THUG 52 NGG", "ЛСП", "Скриптонит",
    "Miyagi", "9mice", "FACE", "MORGENSTHERN", "Big Baby Tape", "Kizaru",
    "GONE.Fludd", "Три дня дождя", "Хаски", "Oxxxymiron", "Noize MC", "Kai Angel",
    "SODA LUV", "FENDIGLOCK", "Yanix", "Bushido Zho"
  ];
  return await getRecoFromArtists(ruArtists);
}

async function getRecoFromArtists(artistsList) {
  const shuffled = [...artistsList].sort(() => Math.random() - 0.5).slice(0, 5);
  
  // allSettled не падает, даже если один запрос упал с ошибкой
  const results = await Promise.allSettled(shuffled.map(name => fetchArtistAlbums(name, 3)));
  
  const all = [];
  results.forEach(res => {
    if (res.status === "fulfilled" && Array.isArray(res.value)) {
      all.push(...res.value);
    }
  });

  const seen = new Set();
  return all.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  }).slice(0, 10);
}

// ============================================================
// ИСТОЧНИКИ ИЗ БАЗЫ (Для вас, Популярное, Случайное)
// ============================================================
async function getPersonalRecommendations(groups) {
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
  if (_isRefreshing) return;

  if (!forceRefresh) {
    const cached = loadCache();
    if (cached) {
      renderAllFromData(cached);
      return;
    }
  }

  _isRefreshing = true;
  try {
    // Грузим базу (для Популярного, Случайного, Для вас)
    const groups = await loadAllRatingsGrouped();

    // Запускаем Spotify-запросы и запросы к базе параллельно
    const [westernHits, russianRap] = await Promise.all([
      getWesternHits(),
      getRussianRap()
    ]);

    const popular = await getPopularOnSite(groups);
    const random = await getRandomFromBase(groups);
    const personal = await getPersonalRecommendations(groups);

    const data = {
      westernHits: westernHits,
      russianRap: russianRap,
      popular: popular,
      random: random,
      personal: personal
    };

    saveCache(data);
    renderAllFromData(data);
  } catch (e) {
    console.warn("Recommendations error:", e);
    const cached = loadCache();
    if (cached) {
      renderAllFromData(cached);
    }
  } finally {
    _isRefreshing = false;
  }
}

function renderAllFromData(data) {
  renderRecoBlock("recoTrending", "recoTrendingList", data.westernHits);
  renderRecoBlock("recoNew", "recoNewList", data.russianRap);
  renderRecoBlock("recoPopular", "recoPopularList", data.popular);
  renderRecoBlock("recoRandom", "recoRandomList", data.random);
  renderRecoBlock("recoPersonal", "recoPersonalList", data.personal);
}

// ============================================================
// ОБНОВЛЕНИЕ
// ============================================================
export async function refreshRecommendations() {
  if (Date.now() < _spotifyCooldown) {
    const sec = Math.ceil((_spotifyCooldown - Date.now()) / 1000);
    showToast("Spotify отдыхает. Подождите " + sec + " сек", { gold: true });
    return;
  }

  const now = Date.now();
  if (now - _lastRefresh < REFRESH_COOLDOWN) {
    const sec = Math.ceil((REFRESH_COOLDOWN - (now - _lastRefresh)) / 1000);
    showToast("Подождите " + sec + " сек", { gold: true });
    return;
  }
  _lastRefresh = now;

  clearCache();
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
export async function refreshRussianReco() {
  const btn = document.querySelector('#recoNew .reco-refresh');
  if (btn) btn.style.transform = "rotate(180deg)";
  
  try {
    const items = await getRussianRap();
    renderRecoBlock("recoNew", "recoNewList", items);
    showToast("Обновлено");
  } catch (e) {
    showToast("Ошибка обновления");
  } finally {
    if (btn) btn.style.transform = "";
  }
}
// Экспорт в window
if (typeof window !== "undefined") {
  window.loadRecommendations = loadRecommendations;
  window.refreshRecommendations = refreshRecommendations;
  window.refreshRandomReco = refreshRandomReco;
}