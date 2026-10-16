// ============================================================
// artists.js — модель артистов и оценок артистов
// ============================================================

import { db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp, addDoc } from './firebase.js';
import { ADMIN_UID, ITUNES_PROXY } from './config.js';
import { escapeHtml, getLevelByXp } from './utils.js';

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