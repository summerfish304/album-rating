// ============================================================
// recommendations.js — рекомендации на главной (v2, из базы)
// ============================================================

import { db, collection, getDocs } from './firebase.js';
import { ITUNES_PROXY } from './config.js';
import { escapeHtml, plural } from './utils.js';
import { showToast } from './ui.js';

let currentUser = null;
let userProfile = null;
let callbacks = {};

export function setRecommendationsContext(opts) {
  if (opts.currentUser !== undefined) currentUser = opts.currentUser;
  if (opts.userProfile !== undefined) userProfile = opts.userProfile;
  if (opts.callbacks !== undefined) callbacks = opts.callbacks || {};
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

// Загружаем все оценки и группируем по релизам
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
// ИСТОЧНИКИ РЕКОМЕНДАЦИЙ
// ============================================================

// 1. В тренде — релизы с наибольшим числом оценок за 7 дней
async function getTrending() {
  const groups = await loadAllRatingsGrouped();
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;

  const recent = groups
    .map(g => {
      const recentRatings = g.ratings.filter(r => (r.ts?.seconds || 0) >= weekAgo);
      return { ...g, recentCount: recentRatings.length };
    })
    .filter(g => g.recentCount > 0)
    .sort((a, b) => b.recentCount - a.recentCount);

  return recent.slice(0, 10).map(g => ({
    id: g.id,
    source: g.source,
    title: g.album.title,
    artist: g.album.artist,
    cover: g.album.artwork,
    year: (g.album.releaseDate || "").slice(0, 4),
    count: g.recentCount,
    isSingle: g.album.isSingleFromAlbum || false
  }));
}

// 2. Новинки — релизы из базы, вышедшие в этом году
async function getNewReleases() {
  const groups = await loadAllRatingsGrouped();
  const thisYear = new Date().getFullYear();

  const fresh = groups
    .filter(g => {
      const releaseMs = parseDate(g.album.releaseDate);
      if (!releaseMs) return false;
      const releaseYear = new Date(releaseMs).getFullYear();
      return releaseYear === thisYear || releaseYear === thisYear - 1;
    })
    .sort((a, b) => {
      const da = parseDate(a.album.releaseDate);
      const db_ = parseDate(b.album.releaseDate);
      return db_ - da;
    });

  return fresh.slice(0, 10).map(g => ({
    id: g.id,
    source: g.source,
    title: g.album.title,
    artist: g.album.artist,
    cover: g.album.artwork,
    year: (g.album.releaseDate || "").slice(0, 4),
    count: g.ratings.length,
    isSingle: g.album.isSingleFromAlbum || false
  }));
}

// 3. Для вас — релизы любимых артистов юзера из базы
async function getPersonalRecommendations() {
  if (!currentUser) return [];
  try {
    // Мои оценки
    const snap = await getDocs(collection(db, "ratings"));
    const all = snap.docs.map(d => d.data()).filter(r => !r.hidden && r.album);
    const myRatings = all.filter(r => r.uid === currentUser.uid);

    if (myRatings.length === 0) return [];

    // Топ-3 любимых артиста
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

    // Релизы этих артистов, которые я ещё не оценил
    const ratedKeys = new Set(myRatings.map(r => r.source + "_" + r.releaseId));

    const byRelease = {};
    all.forEach(r => {
      const key = r.source + "_" + r.releaseId;
      if (ratedKeys.has(key)) return;
      if (!favArtists.some(a => r.album.artist && r.album.artist.includes(a))) return;
      if (!byRelease[key]) {
        byRelease[key] = {
          id: r.releaseId,
          source: r.source,
          album: r.album,
          count: 0
        };
      }
      byRelease[key].count++;
    });

    return Object.values(byRelease)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(g => ({
        id: g.id,
        source: g.source,
        title: g.album.title,
        artist: g.album.artist,
        cover: g.album.artwork,
        year: (g.album.releaseDate || "").slice(0, 4),
        count: g.count,
        isSingle: g.album.isSingleFromAlbum || false
      }));
  } catch (e) {
    console.warn("Personal reco error:", e.message);
    return [];
  }
}

// 4. Случайное из базы
async function getRandomFromBase() {
  const groups = await loadAllRatingsGrouped();
  if (groups.length === 0) return [];
  const shuffled = [...groups].sort(() => Math.random() - 0.5).slice(0, 5);
  return shuffled.map(g => ({
    id: g.id,
    source: g.source,
    title: g.album.title,
    artist: g.album.artist,
    cover: g.album.artwork,
    year: (g.album.releaseDate || "").slice(0, 4),
    count: g.ratings.length,
    isSingle: g.album.isSingleFromAlbum || false
  }));
}

// 5. Популярное на сайте — топ по числу оценок за всё время
async function getPopularOnSite() {
  const groups = await loadAllRatingsGrouped();
  const popular = [...groups].sort((a, b) => b.ratings.length - a.ratings.length);
  return popular.slice(0, 10).map(g => ({
    id: g.id,
    source: g.source,
    title: g.album.title,
    artist: g.album.artist,
    cover: g.album.artwork,
    year: (g.album.releaseDate || "").slice(0, 4),
    count: g.ratings.length,
    isSingle: g.album.isSingleFromAlbum || false
  }));
}

// ============================================================
// РЕНДЕР
// ============================================================
function renderRecoBlock(blockId, listId, items, emptyText) {
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
export async function loadRecommendations() {
  // Загружаем один раз — общие данные, потом распределяем
  const groups = await loadAllRatingsGrouped();

  // Тренды
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;
  const trending = groups
    .map(g => ({
      ...g,
      recentCount: g.ratings.filter(r => (r.ts?.seconds || 0) >= weekAgo).length
    }))
    .filter(g => g.recentCount > 0)
    .sort((a, b) => b.recentCount - a.recentCount)
    .slice(0, 10)
    .map(g => ({
      id: g.id, source: g.source,
      title: g.album.title, artist: g.album.artist,
      cover: g.album.artwork, year: (g.album.releaseDate || "").slice(0, 4),
      count: g.recentCount
    }));
  renderRecoBlock("recoTrending", "recoTrendingList", trending);

  // Новинки
  const thisYear = new Date().getFullYear();
  const fresh = groups
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
  renderRecoBlock("recoNew", "recoNewList", fresh);

  // Популярное
  const popular = [...groups]
    .sort((a, b) => b.ratings.length - a.ratings.length)
    .slice(0, 10)
    .map(g => ({
      id: g.id, source: g.source,
      title: g.album.title, artist: g.album.artist,
      cover: g.album.artwork, year: (g.album.releaseDate || "").slice(0, 4),
      count: g.ratings.length
    }));
  renderRecoBlock("recoPopular", "recoPopularList", popular);

  // Персональные
  const personal = await getPersonalRecommendations();
  renderRecoBlock("recoPersonal", "recoPersonalList", personal);

  // Случайное
  const random = await getRandomFromBase();
  renderRecoBlock("recoRandom", "recoRandomList", random);
}

export function refreshRecommendations() {
  loadRecommendations();
  showToast("Обновлено");
}

export async function refreshRandomReco() {
  const items = await getRandomFromBase();
  renderRecoBlock("recoRandom", "recoRandomList", items);
}

export function setRecommendationsVisible(visible) {
  const section = document.getElementById("recommendationsSection");
  if (!section) return;
  if (visible) section.classList.remove("hidden");
  else section.classList.add("hidden");
}

if (typeof window !== "undefined") {
  window.loadRecommendations = loadRecommendations;
  window.refreshRecommendations = refreshRecommendations;
  window.refreshRandomReco = refreshRandomReco;
}