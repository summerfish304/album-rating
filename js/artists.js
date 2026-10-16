// ============================================================
// artists.js — модель артистов и оценок артистов
// ============================================================

import { db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp, addDoc } from './firebase.js';
import { ADMIN_UID, ITUNES_PROXY } from './config.js';
import { escapeHtml, getLevelByXp, getTier } from './utils.js';

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
  limit = limit || 50;
  const data = await spotifyFetch(
    "/artists/" + artistId + "/albums?include_groups=album,single&limit=" + Math.min(50, limit)
  );
  const items = (data.items || []);
  // Сортируем по дате выхода (новые сверху)
  items.sort((a, b) => {
    const da = a.release_date || "";
    const db_ = b.release_date || "";
    return db_.localeCompare(da);
  });
  return items;
}

// Топ-треки артиста
export async function getArtistTopTracks(artistId, market) {
  market = market || "US";
  const data = await spotifyFetch(
    "/artists/" + artistId + "/top-tracks?market=" + market
  );
  return data.tracks || [];
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

// -------- Открыть вкладку «Артисты» --------
export function openArtistsTab() {
  // Сбрасываем на поиск
  document.getElementById("artistsSearchView").classList.remove("hidden");
  document.getElementById("artistPageView").classList.add("hidden");
  renderRecentArtists();
  // Фокус в поиск
  setTimeout(() => {
    const inp = document.getElementById("artistSearchInput");
    if (inp) inp.focus();
  }, 100);
}

// -------- Ввод в поиске --------
export function onArtistSearchInput() {
  const q = document.getElementById("artistSearchInput").value.trim();
  const listEl = document.getElementById("artistSuggestions");
  clearTimeout(artistSearchDebounce);

  if (q.length < 2) {
    listEl.classList.remove("open");
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = '<div class="status"><span class="spinner"></span> Поиск…</div>';
  listEl.classList.add("open");

  artistSearchDebounce = setTimeout(async () => {
    try {
      const items = await searchArtists(q, 15);
      const mapped = items.map(mapSpotifyArtist);
      if (mapped.length === 0) {
        listEl.innerHTML = '<div class="status">Ничего не найдено</div>';
        return;
      }
      currentSuggestions = mapped;
      listEl.innerHTML = "";
      mapped.forEach((a, i) => {
        const el = document.createElement("div");
        el.className = "suggestion artist-suggestion";
        el.innerHTML =
          (a.photo
            ? '<img src="' + escapeHtml(a.photo) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
            : '<div class="artist-suggestion-noimg">🎤</div>') +
          '<div class="text">' +
            '<div class="t">' + escapeHtml(a.name) + '</div>' +
            '<div class="a">' + (a.genres && a.genres.length ? escapeHtml(a.genres.slice(0, 2).join(", ")) : "Артист") + '</div>' +
          '</div>';
        el.onmousedown = (e) => { e.preventDefault(); openArtist(a.id); };
        listEl.appendChild(el);
      });
      listEl.classList.add("open");
    } catch (e) {
      listEl.innerHTML = '<div class="status">Ошибка: ' + escapeHtml(e.message) + '</div>';
    }
  }, 400);
}

export function onArtistSearchKeydown(e) {
  if (e.key === "Escape") {
    document.getElementById("artistSuggestions").classList.remove("open");
  }
}

// -------- Открыть страницу артиста --------
export async function openArtist(artistId) {
  if (!artistId) return;
  document.getElementById("artistSuggestions").classList.remove("open");
  document.getElementById("artistsSearchView").classList.add("hidden");
  document.getElementById("artistPageView").classList.remove("hidden");

  const content = document.getElementById("artistPageContent");
  content.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка артиста…</div>';

  try {
    const data = await getArtistById(artistId);
    const artist = mapSpotifyArtist(data);
    currentArtist = artist;

    // Параллельно грузим альбомы и топ-треки
    const [albumsRaw, tracksRaw] = await Promise.all([
      getArtistAlbums(artistId, 50).catch(() => []),
      getArtistTopTracks(artistId).catch(() => [])
    ]);

    const albums = albumsRaw.map(mapSpotifyArtistAlbum);
    const tracks = tracksRaw.slice(0, 5).map(t => ({
      name: t.name,
      album: t.album?.name || "",
      cover: t.album?.images?.[0]?.url ? PROXY + "?u=" + encodeURIComponent(t.album.images[0].url) : "",
      preview: t.preview_url || "",
      duration: t.duration_ms || 0
    }));

    // Сохраняем в Firestore (кэш)
    saveArtistToFirestore(artist);

    renderArtistPage(artist, albums, tracks);
    // Прокрутка вверх
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    content.innerHTML = '<div class="error">Ошибка загрузки артиста: ' + escapeHtml(e.message) + '</div>';
  }
}

// -------- Рендер страницы артиста --------
function renderArtistPage(artist, albums, tracks) {
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
          '<button onclick="openArtistRatingForm(\'' + artist.id + '\')">⭐ Оценить артиста</button>' +
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
  document.getElementById("artistPageView").classList.add("hidden");
  document.getElementById("artistsSearchView").classList.remove("hidden");
  currentArtist = null;
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

// -------- Заглушка для кнопки «Оценить артиста» --------
export function openArtistRatingForm(artistId) {
  // TODO: в Блоке 9.2.2
  alert("Скоро: форма оценки артиста. Открыта страница: " + artistId);
}

// -------- Недавно оценённые артисты (на экране поиска) --------
async function renderRecentArtists() {
  const el = document.getElementById("artistsRecentBlock");
  if (!el) return;
  if (!currentUser) { el.innerHTML = ""; return; }

  const myRatings = await loadMyArtistRatings();
  if (!myRatings.length) {
    el.innerHTML =
      '<div class="artist-search-hint">' +
        '<div class="artist-search-hint-icon">🎤</div>' +
        '<div>Найдите артиста через поиск и поставьте ему оценку по 5 критериям.</div>' +
      '</div>';
    return;
  }

  el.innerHTML =
    '<div class="artist-section" style="margin-top:20px;">' +
      '<div class="artist-section-header">📝 Мои оценённые артисты (' + myRatings.length + ')</div>' +
      '<div class="artist-my-list">' +
        myRatings.slice(0, 20).map(r => {
          const tier = getTier(r.final);
          return '<div class="artist-my-item" onclick="openArtist(\'' + escapeHtml(r.artistId) + '\')">' +
            (r.artist?.photo
              ? '<img src="' + escapeHtml(r.artist.photo) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
              : '<div class="artist-my-noimg">🎤</div>') +
            '<div class="artist-my-info">' +
              '<div class="artist-my-name">' + escapeHtml(r.artist?.name || "—") + '</div>' +
              '<div class="artist-my-tier">' + tier.emoji + ' ' + escapeHtml(tier.name) + '</div>' +
            '</div>' +
            '<div class="artist-my-score" style="color:' + tier.color + '">' + r.final + '</div>' +
          '</div>';
        }).join("") +
      '</div>' +
    '</div>';
}

// Экспорт в window для onclick
if (typeof window !== "undefined") {
  window.onArtistSearchInput = onArtistSearchInput;
  window.onArtistSearchKeydown = onArtistSearchKeydown;
  window.openArtist = openArtist;
  window.closeArtistPage = closeArtistPage;
  window.openAlbumFromArtist = openAlbumFromArtist;
  window.openArtistRatingForm = openArtistRatingForm;
}