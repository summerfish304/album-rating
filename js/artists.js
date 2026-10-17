// ============================================================
// artists.js — модель артистов и оценок артистов
// ============================================================

import { db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp, addDoc } from './firebase.js';
import {
  ADMIN_UID, ITUNES_PROXY,
  ARTIST_CRITERIA, ARTIST_VIBE_KEY, ARTIST_MAIN_CRITERIA,
  VERDICTS_ARTIST, FINAL_MAX
} from './config.js';
import { escapeHtml, getLevelByXp, getTier, computeFinalScore, getNextTier } from './utils.js';
import { showToast } from './ui.js';
// ============================================================
// Состояние модуля
// ============================================================
let currentUser = null;
let userProfile = null;
let callbacks = {};

export function setArtistsContext(opts) {
  if (opts.currentUser !== undefined) currentUser = opts.currentUser;
  if (opts.userProfile !== undefined) userProfile = opts.userProfile;
  if (opts.callbacks !== undefined) callbacks = opts.callbacks || {};
}

// ============================================================
// SPOTIFY API — поиск и данные артиста
// ============================================================
const PROXY = ITUNES_PROXY;

async function spotifyFetch(path) {
  const target = "https://api.spotify.com/v1" + path;
  const res = await fetch(PROXY + "?u=" + encodeURIComponent(target));
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Spotify HTTP " + res.status + ": " + text.slice(0, 120));
  }
  return res.json();
}

// Поиск артистов
export async function searchArtists(query, limit) {
  limit = limit || 20;
  const data = await spotifyFetch(
    "/search?q=" + encodeURIComponent(query) + "&type=artist"
  );
  const items = (data.artists && data.artists.items) || [];
  return items.slice(0, Math.max(1, Math.min(50, limit)));
}

// Загрузка артиста по ID
export async function getArtistById(artistId) {
  return spotifyFetch("/artists/" + artistId);
}

// Дискография артиста (альбомы + синглы + EP)
export async function getArtistAlbums(artistId, limit) {
  limit = limit || 200;
  try {
    // Первый запрос — узнаём total
    const firstUrl = "/artists/" + artistId + "/albums?include_groups=album,single,compilation&offset=0";
    const firstPage = await spotifyFetch(firstUrl);
    const total = typeof firstPage.total === "number" ? firstPage.total : (firstPage.items || []).length;
    let allItems = [...(firstPage.items || [])];

    if (allItems.length >= total || allItems.length >= limit) {
      return sortAndSlice(allItems, limit);
    }

    // Считаем, сколько ещё страниц нужно
    const PAGE_SIZE = 5;
    const pagesNeeded = Math.min(60, Math.ceil((Math.min(total, limit) - allItems.length) / PAGE_SIZE));
    const offsets = [];
    for (let i = 1; i <= pagesNeeded; i++) {
      offsets.push(i * PAGE_SIZE);
    }

    // Загружаем параллельно, по 4 запроса за раз
    const CONCURRENCY = 4;
    for (let i = 0; i < offsets.length; i += CONCURRENCY) {
      const batch = offsets.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (offset) => {
        try {
          const url = "/artists/" + artistId + "/albums?include_groups=album,single,compilation&offset=" + offset;
          const page = await spotifyFetch(url);
          return page.items || [];
        } catch (e) {
          console.warn("Ошибка страницы offset=" + offset + ":", e.message);
          return [];
        }
      }));
      results.forEach(chunk => { allItems = allItems.concat(chunk); });
      if (allItems.length >= total || allItems.length >= limit) break;
    }

    console.log("[Artists] " + artistId + " — загружено " + allItems.length + " из " + total + " релизов Spotify");

    return sortAndSlice(allItems, limit);
  } catch (e) {
    console.warn("Ошибка загрузки альбомов артиста:", e.message);
    return [];
  }
}

function sortAndSlice(items, limit) {
  items.sort((a, b) => {
    const da = a.release_date || "";
    const db_ = b.release_date || "";
    return db_.localeCompare(da);
  });
  return items.slice(0, limit);
}

// Топ-треки артиста
export async function getArtistTopTracks(artistId) {
  try {
    // Попробуем с market — если 403, вернём пустой массив
    const data = await spotifyFetch(
      "/artists/" + artistId + "/top-tracks?market=US"
    );
    return data.tracks || [];
  } catch (e) {
    console.warn("Не удалось загрузить топ-треки:", e.message);
    return [];
  }
}

// Нормализация артиста из Spotify → наш формат
export function mapSpotifyArtist(a) {
  const rawPhoto = (a.images && a.images[0] && a.images[0].url) ||
                   (a.images && a.images[1] && a.images[1].url) || "";
  const photo = rawPhoto ? PROXY + "?u=" + encodeURIComponent(rawPhoto) : "";
  return {
    id: a.id,
    name: a.name,
    photo: photo,
    followers: a.followers?.total || 0,
    genres: a.genres || [],
    popularity: a.popularity || 0,
    spotifyUrl: a.external_urls?.spotify || ""
  };
}

// Нормализация альбома из Spotify
export function mapSpotifyArtistAlbum(a) {
  const rawCover = (a.images && a.images[0] && a.images[0].url) ||
                   (a.images && a.images[1] && a.images[1].url) || "";
  const cover = rawCover ? PROXY + "?u=" + encodeURIComponent(rawCover) : "";
  return {
    id: a.id,
    title: a.name,
    artist: (a.artists || []).map(x => x.name).join(", "),
    cover: cover,
    releaseDate: a.release_date || "",
    year: (a.release_date || "").slice(0, 4),
    type: a.album_type || "album",   // album | single | compilation
    totalTracks: a.total_tracks || 0
  };
}

// ============================================================
// FIRESTORE — сохранение артиста (кэш)
// ============================================================
export async function saveArtistToFirestore(artist) {
  if (!artist || !artist.id) return;
  try {
    const ref = doc(db, "artists", artist.id);
    const snap = await getDoc(ref);
    const base = {
      id: artist.id,
      name: artist.name,
      photo: artist.photo || "",
      followers: artist.followers || 0,
      genres: artist.genres || [],
      popularity: artist.popularity || 0,
      spotifyUrl: artist.spotifyUrl || "",
      updatedAt: serverTimestamp()
    };
    if (!snap.exists()) {
      base.createdAt = serverTimestamp();
      base.createdBy = currentUser ? currentUser.uid : null;
      await setDoc(ref, base);
    } else {
      await updateDoc(ref, base);
    }
  } catch (e) {
    console.warn("Не удалось сохранить артиста:", e.message);
  }
}

// Загрузить артиста из Firestore (кэш)
export async function loadArtistFromFirestore(artistId) {
  try {
    const snap = await getDoc(doc(db, "artists", artistId));
    return snap.exists() ? snap.data() : null;
  } catch (e) { return null; }
}

// ============================================================
// ОЦЕНКИ АРТИСТОВ — сохранение
// ============================================================
export async function saveArtistRating(artist, values, reviewText) {
  if (!currentUser) throw new Error("Нужно войти");
  if (!artist || !artist.id) throw new Error("Нет артиста");

  const docId = artist.id + "_" + currentUser.uid;

  // Формула как у релизов: base × 36 × vibeFactor
  const { computeFinalScore, computeSingleScore } = await import('./utils.js');

  // computeSingleScore ожидает объект вида { rhymes, structure, ... }
  // Для артистов критерии другие → используем свою формулу
  const mainKeys = ["vocals", "lyrics", "music", "uniqueness", "charisma"];
  let sum = 0;
  mainKeys.forEach(k => { sum += values[k] || 7; });
  const avgMain = sum / mainKeys.length;

  const allPerfect = mainKeys.every(k => (values[k] || 7) === 10);
  const base = allPerfect ? 10 : Math.max(1, Math.min(9.75, Math.floor(avgMain * 4) / 4));

  const vibe = values.vibe || 7;
  const final = computeFinalScore([base], vibe);

  const ratingData = {
    uid: currentUser.uid,
    nickname: userProfile.nickname,
    avatar: userProfile.avatar || "🎵",
    level: getLevelByXp(userProfile.xp || 0).level,
    artistId: artist.id,
    artist: {
      id: artist.id,
      name: artist.name,
      photo: artist.photo,
      genres: artist.genres || []
    },
    values: values,
    base: +avgMain.toFixed(2),
    vibe: vibe,
    final: final,
    review: (reviewText || "").trim(),
    ts: serverTimestamp()
  };

  // Проверяем — уже была оценка?
  const existing = await getDoc(doc(db, "artist_ratings", docId));
  const isNew = !existing.exists();

  if (isNew) {
    await setDoc(doc(db, "artist_ratings", docId), ratingData);
  } else {
    await setDoc(doc(db, "artist_ratings", docId), {
      ...ratingData,
      createdAt: existing.data().createdAt || serverTimestamp()
    }, { merge: true });
  }

  // Если есть текст рецензии — сохраняем отдельно (или в поле review)
  // Пока оставляем review в самом документе оценки.

  return { isNew, final, docId };
}

// Удалить свою оценку артиста
export async function deleteMyArtistRating(artistId) {
  if (!currentUser) return;
  const docId = artistId + "_" + currentUser.uid;
  try {
    await deleteDoc(doc(db, "artist_ratings", docId));
    return true;
  } catch (e) {
    console.warn("Ошибка удаления:", e.message);
    return false;
  }
}

// Загрузить мою оценку артиста
export async function loadMyArtistRating(artistId) {
  if (!currentUser) return null;
  const docId = artistId + "_" + currentUser.uid;
  try {
    const snap = await getDoc(doc(db, "artist_ratings", docId));
    return snap.exists() ? { _id: snap.id, ...snap.data() } : null;
  } catch (e) { return null; }
}

// Загрузить все мои оценки артистов
export async function loadMyArtistRatings() {
  if (!currentUser) return [];
  try {
    const q = query(collection(db, "artist_ratings"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    const items = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    items.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
    return items;
  } catch (e) { return []; }
}

// Загрузить все оценки артиста (по artistId)
export async function loadArtistRatings(artistId) {
  try {
    const q = query(collection(db, "artist_ratings"), where("artistId", "==", artistId));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
  } catch (e) { return []; }
}

// ============================================================
// Экспорт для отладки
// ============================================================
if (typeof window !== "undefined") {
  window.__artists = {
    searchArtists,
    getArtistById,
    getArtistAlbums,
    getArtistTopTracks,
    mapSpotifyArtist,
    mapSpotifyArtistAlbum
  };
}
// ============================================================
// UI: ПОИСК И СТРАНИЦА АРТИСТА
// ============================================================

let artistSearchDebounce = null;
let currentSuggestions = [];
let currentArtist = null;      // артист, открытый на странице



// -------- Открыть страницу артиста --------
export async function openArtist(artistId) {
  if (!artistId) return;

  // Закрываем подсказки, если открыты
  const sugg = document.getElementById("suggestionList");
  if (sugg) sugg.classList.remove("open");

  // Скрываем содержимое главной, показываем страницу артиста
  const mainContent = document.getElementById("mainDefaultContent");
  const artistView = document.getElementById("artistPageView");
  if (mainContent) mainContent.classList.add("hidden");
  if (artistView) artistView.classList.remove("hidden");

  const content = document.getElementById("artistPageContent");
  content.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка артиста…</div>';

  // Прокрутка наверх
  window.scrollTo({ top: 0, behavior: "smooth" });

  try {
    const data = await getArtistById(artistId);
    const artist = mapSpotifyArtist(data);
    currentArtist = artist;

    // Параллельно грузим альбомы и топ-треки
    const albumsRaw = await getArtistAlbums(artistId, 200).catch(() => []);
    const albums = albumsRaw.map(mapSpotifyArtistAlbum);
    const tracks = [];   // Топ-треки недоступны через Client Credentials Flow

    // Сохраняем в Firestore (кэш)
    saveArtistToFirestore(artist);

    const myRating = await loadMyArtistRating(artistId);
    renderArtistPage(artist, albums, tracks, myRating);
    // Прокрутка вверх
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    content.innerHTML = '<div class="error">Ошибка загрузки артиста: ' + escapeHtml(e.message) + '</div>';
  }
}

// -------- Рендер страницы артиста --------
function renderArtistPage(artist, albums, tracks, myRating) {
  const content = document.getElementById("artistPageContent");

  const albumsOnly = albums.filter(a => a.type === "album");
  const singlesOnly = albums.filter(a => a.type === "single");

  content.innerHTML =
    // Хедер артиста
    '<div class="artist-header">' +
      (artist.photo
        ? '<img class="artist-photo" src="' + escapeHtml(artist.photo) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="artist-photo artist-photo-noimg">🎤</div>') +
      '<div class="artist-header-info">' +
        '<div class="artist-name">' + escapeHtml(artist.name) + '</div>' +
        (artist.genres && artist.genres.length
          ? '<div class="artist-genres">' + artist.genres.slice(0, 4).map(g => escapeHtml(g)).join(" · ") + '</div>'
          : '') +
        '<div class="artist-meta">' +
          (artist.followers
            ? '<span class="artist-stat">👥 ' + formatFollowers(artist.followers) + '</span>'
            : '') +
        '</div>' +
        '<div class="artist-actions">' +
          (myRating
            ? (() => {
                const tier = getTier(myRating.final);
                return '<div class="artist-my-rating">' +
                  '<span class="artist-my-rating-label">Моя оценка:</span>' +
                  '<span class="artist-my-rating-score" style="color:' + tier.color + '">' + myRating.final + '</span>' +
                  '<span class="artist-my-rating-tier">' + tier.emoji + ' ' + escapeHtml(tier.name) + '</span>' +
                  '<button class="btn-secondary btn-sm" onclick="openArtistRatingForm(\'' + artist.id + '\')">✏️ Изменить</button>' +
                '</div>';
              })()
            : '<button onclick="openArtistRatingForm(\'' + artist.id + '\')">⭐ Оценить артиста</button>'
          ) +
          '<button class="fav-toggle-btn" id="artistFavBtn" onclick="toggleArtistFavorite(\'' + artist.id + '\', \'' + escapeHtml(artist.name).replace(/'/g, "\\'") + '\', \'' + escapeHtml(artist.photo || "").replace(/'/g, "\\'") + '\')">⭐ В избранное</button>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // Топ-треки
    (tracks.length > 0
      ? '<div class="artist-section">' +
          '<div class="artist-section-header">🎵 Топ треков</div>' +
          '<div class="artist-tracks">' +
            tracks.map((t, i) =>
              '<div class="artist-track">' +
                '<div class="artist-track-num">' + (i + 1) + '</div>' +
                (t.cover
                  ? '<img class="artist-track-cover" src="' + escapeHtml(t.cover) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
                  : '<div class="artist-track-cover artist-track-noimg">🎵</div>') +
                '<div class="artist-track-info">' +
                  '<div class="artist-track-name">' + escapeHtml(t.name) + '</div>' +
                  '<div class="artist-track-album">' + escapeHtml(t.album) + '</div>' +
                '</div>' +
              '</div>').join("") +
          '</div>' +
        '</div>'
      : '') +

    // Дискография — альбомы
    (albumsOnly.length > 0
      ? '<div class="artist-section">' +
          '<div class="artist-section-header">💿 Альбомы (' + albumsOnly.length + ')</div>' +
          '<div class="artist-albums">' +
            albumsOnly.map(a => renderAlbumCard(a)).join("") +
          '</div>' +
        '</div>'
      : '') +

    // Дискография — синглы/EP
    (singlesOnly.length > 0
      ? '<div class="artist-section">' +
          '<div class="artist-section-header">🎵 Синглы и EP (' + singlesOnly.length + ')</div>' +
          '<div class="artist-albums">' +
            singlesOnly.slice(0, 30).map(a => renderAlbumCard(a)).join("") +
          '</div>' +
        '</div>'
      : '');
}

function renderAlbumCard(a) {
  return '<div class="artist-album-card" onclick="openAlbumFromArtist(\'' + escapeHtml(a.id) + '\')">' +
    (a.cover
      ? '<img class="artist-album-cover" src="' + escapeHtml(a.cover) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
      : '<div class="artist-album-cover artist-album-noimg">💿</div>') +
    '<div class="artist-album-info">' +
      '<div class="artist-album-title">' + escapeHtml(a.title) + '</div>' +
      '<div class="artist-album-year">' + escapeHtml(a.year) +
        ' · ' + plural(a.totalTracks, "трек", "трека", "треков") +
      '</div>' +
    '</div>' +
  '</div>';
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function formatFollowers(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

// -------- Вернуться к поиску --------
export function closeArtistPage() {
  const mainContent = document.getElementById("mainDefaultContent");
  const artistView = document.getElementById("artistPageView");
  if (artistView) artistView.classList.add("hidden");
  if (mainContent) mainContent.classList.remove("hidden");
  currentArtist = null;

  // Прокрутка наверх
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// -------- Клик по альбому → открываем оценку релиза --------
export function openAlbumFromArtist(albumId) {
  // Переходим на вкладку «Оценивать» и загружаем релиз
  if (callbacks.onSwitchNav) callbacks.onSwitchNav("main");
  if (callbacks.onLoadAlbum) {
    setTimeout(() => {
      callbacks.onLoadAlbum({ id: albumId, title: "", cover: "", source: "spotify" });
    }, 300);
  }
}



// ============================================================
// ФОРМА ОЦЕНКИ АРТИСТА
// ============================================================


let artistModalValues = {};
let artistModalArtist = null;

// Открыть форму
export async function openArtistRatingForm(artistId) {
  if (!currentUser) {
    showToast && showToast("Нужно войти");
    return;
  }
  const artist = currentArtist;
  if (!artist || artist.id !== artistId) {
    // Если артиста нет в памяти — грузим
    try {
      const data = await getArtistById(artistId);
      artistModalArtist = mapSpotifyArtist(data);
    } catch (e) {
      console.error("Не удалось открыть форму:", e);
      return;
    }
  } else {
    artistModalArtist = artist;
  }

  const modal = document.getElementById("artistRatingBackdrop");
  if (!modal) return;

  // Заполняем шапку
  const photoEl = document.getElementById("artistRatingPhoto");
  if (photoEl) {
    photoEl.src = artistModalArtist.photo || "";
    photoEl.style.visibility = artistModalArtist.photo ? "visible" : "hidden";
  }
  document.getElementById("artistRatingName").textContent = artistModalArtist.name;
  document.getElementById("artistRatingGenres").textContent =
    (artistModalArtist.genres && artistModalArtist.genres.length
      ? artistModalArtist.genres.slice(0, 3).join(", ")
      : "Артист");

  // Загружаем существующую оценку (если есть)
  const existing = await loadMyArtistRating(artistId);

  artistModalValues = {};
  ARTIST_CRITERIA.forEach(c => { artistModalValues[c.key] = 7; });

  if (existing && existing.values) {
    Object.keys(existing.values).forEach(k => {
      if (artistModalValues[k] !== undefined) artistModalValues[k] = existing.values[k];
    });
  }

  // Рецензия
  const reviewInput = document.getElementById("artistReviewInput");
  if (reviewInput) {
    reviewInput.value = (existing && existing.review) || "";
  }

  renderArtistCriteria();
  updateArtistModalTotal();

  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

// Закрыть
export function closeArtistRatingForm() {
  const modal = document.getElementById("artistRatingBackdrop");
  if (modal) modal.classList.remove("open");
  document.body.style.overflow = "";
}

// Хелп
export function toggleArtistHelp() {
  const box = document.getElementById("artistHelpBox");
  if (box) box.classList.toggle("hidden");
}

// Рендер критериев
function renderArtistCriteria() {
  const wrap = document.getElementById("artistCriteriaList");
  if (!wrap) return;
  wrap.innerHTML = "";

  ARTIST_CRITERIA.forEach(c => {
    const isVibe = c.key === ARTIST_VIBE_KEY;
    const block = document.createElement("div");
    block.className = "criterion" + (isVibe ? " vibe-criterion" : "");

    const head = document.createElement("div");
    head.className = "criterion-head";
    const multBadge = isVibe ? '<span class="mult-badge">×Множитель</span>' : "";
    head.innerHTML =
      '<div class="criterion-name">' +
        '<span class="criterion-emoji">' + c.emoji + '</span>' +
        '<span>' + c.name + multBadge + '</span>' +
      '</div>' +
      '<div class="criterion-val" data-key="' + c.key + '">' + artistModalValues[c.key] + '</div>';
    block.appendChild(head);

    const controls = document.createElement("div");
    controls.className = "criterion-controls";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = 1;
    slider.max = 10;
    slider.step = 1;
    slider.value = artistModalValues[c.key];
    updateSliderFill(slider);

    slider.oninput = () => {
      const v = parseInt(slider.value);
      artistModalValues[c.key] = v;
      head.querySelector(".criterion-val").textContent = v;
      updateSliderFill(slider);
      updateArtistModalTotal();
    };
    controls.appendChild(slider);
    block.appendChild(controls);

    wrap.appendChild(block);
  });
}

// Обновить общую оценку
function updateArtistModalTotal() {
  let sum = 0;
  ARTIST_MAIN_CRITERIA.forEach(c => { sum += artistModalValues[c.key] || 7; });
  const avgMain = sum / ARTIST_MAIN_CRITERIA.length;

  const allPerfect = ARTIST_MAIN_CRITERIA.every(c => (artistModalValues[c.key] || 7) === 10);
  const base = allPerfect ? 10 : Math.max(1, Math.min(9.75, Math.floor(avgMain * 4) / 4));

  const vibe = artistModalValues[ARTIST_VIBE_KEY] || 7;
  const final = computeFinalScore([base], vibe);

  const totalEl = document.getElementById("artistModalTotal");
  const hintEl = document.getElementById("artistModalHint");
  if (totalEl) totalEl.textContent = final;
  if (hintEl) {
    const tier = getTier(final);
    const verdict = VERDICTS_ARTIST[tier.name] || "";
    hintEl.innerHTML = 'из 360 · <b>' + tier.emoji + ' ' + tier.name + '</b><br><span style="opacity:.7">' + verdict + '</span>';
  }
}

// Применить оценку (сохранить)
export async function applyArtistRating() {
  if (!currentUser) {
    alert("Нужно войти");
    return;
  }
  if (!artistModalArtist) return;

  const reviewText = (document.getElementById("artistReviewInput")?.value || "").trim();

  try {
    const res = await saveArtistRating(artistModalArtist, artistModalValues, reviewText);

    // Сохраняем в activity
    try {
      if (callbacks.onPushActivity && res.isNew) {
        await callbacks.onPushActivity({
          type: "artist_rating",
          uid: currentUser.uid,
          nickname: userProfile.nickname,
          avatar: userProfile.avatar || "🎵",
          level: getLevelByXp(userProfile.xp || 0).level,
          artistId: artistModalArtist.id,
          artistName: artistModalArtist.name,
          artistPhoto: artistModalArtist.photo,
          final: res.final
        });
      }
    } catch (e) {}

    if (callbacks.onAfterArtistRating) callbacks.onAfterArtistRating(artistModalArtist.id);

    closeArtistRatingForm();
    showToast && showToast("Оценка артиста сохранена: " + res.final, { success: true });
  } catch (e) {
    console.error(e);
    alert("Ошибка: " + e.message);
  }
}

// Обёртка updateSliderFill (если её нет в artists.js)
function updateSliderFill(slider) {
  const min = +slider.min, max = +slider.max, val = +slider.value;
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = "linear-gradient(90deg, var(--accent) 0%, var(--accent-3) " + pct + "%, var(--border) " + pct + "%, var(--border) 100%)";
}

// Тогл «В избранное» для артиста
export async function toggleArtistFavorite(artistId, artistName, artistPhoto) {
  if (!currentUser) { showToast("Нужно войти"); return; }
  const btn = document.getElementById("artistFavBtn");
  if (!btn) return;

  const { isFavorite, addToFavorites, removeFromFavorites, loadFavorites } = await import('./search.js');
  const fav = await isFavorite("artist", artistId);

  if (fav) {
    // Удаляем
    const list = await loadFavorites();
    const item = list.find(f => f.kind === "artist" && f.itemId === artistId);
    if (item) await removeFromFavorites(item._id);
    btn.classList.remove("active");
    btn.innerHTML = "⭐ В избранное";
  } else {
    await addToFavorites({
      kind: "artist",
      id: artistId,
      title: artistName,
      artist: (currentArtist && currentArtist.genres) ? currentArtist.genres.slice(0, 2).join(", ") : "Артист",
      cover: artistPhoto
    });
    btn.classList.add("active");
    btn.innerHTML = "★ В избранном";
  }
}

// Экспорт в window для onclick
if (typeof window !== "undefined") {
  window.toggleArtistFavorite = toggleArtistFavorite;
  window.openArtist = openArtist;
  window.closeArtistPage = closeArtistPage;
  window.openAlbumFromArtist = openAlbumFromArtist;
  window.openArtistRatingForm = openArtistRatingForm;
}