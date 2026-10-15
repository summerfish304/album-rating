// ============================================================
// season-awards.js — подсчёт наград сезона
// ============================================================

import { db, collection, getDocs } from './firebase.js';
import { ADMIN_UID } from './config.js';

// Адаптивный порог количества оценок для номинации
function getMinRatingsThreshold(totalRatingsInSeason) {
  if (totalRatingsInSeason < 50) return 2;
  if (totalRatingsInSeason < 100) return 3;
  return 5;
}

// Проверка: дата релиза попадает в сезон
function isReleaseInSeason(releaseDateStr, season) {
  if (!releaseDateStr) return false;
  if (!season || !season.startedAt || !season.endsAt) return false;

  // releaseDateStr может быть "YYYY-MM-DD", "YYYY-MM", "YYYY"
  const parts = releaseDateStr.split("-");
  const year = parseInt(parts[0]);
  const month = parts[1] ? parseInt(parts[1]) - 1 : 0;   // 0-indexed
  const day = parts[2] ? parseInt(parts[2]) : 1;
  const releaseMs = new Date(year, month, day).getTime();
  if (isNaN(releaseMs)) return false;

  const startMs = season.startedAt?.seconds
    ? season.startedAt.seconds * 1000
    : new Date(season.startedAt).getTime();
  const endMs = season.endsAt?.seconds
    ? season.endsAt.seconds * 1000
    : new Date(season.endsAt).getTime();

  return releaseMs >= startMs && releaseMs <= endMs;
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ: подсчитать награды сезона
// ============================================================
export async function computeSeasonAwards(season) {
  if (!season) return null;

  const snap = await getDocs(collection(db, "ratings"));
  const allRatings = snap.docs.map(d => d.data()).filter(r => !r.hidden);

  // Фильтруем оценки, чьи релизы вышли в сезоне
  const seasonRatings = allRatings.filter(r => {
    const releaseDate = r.album && r.album.releaseDate;
    return isReleaseInSeason(releaseDate, season);
  });

  const totalRatingsInSeason = seasonRatings.length;
  const minRatings = getMinRatingsThreshold(totalRatingsInSeason);

  // Группируем по релизам
  const byRelease = {};
  seasonRatings.forEach(r => {
    const key = r.source + "_" + r.releaseId;
    if (!byRelease[key]) {
      byRelease[key] = {
        releaseId: r.releaseId,
        source: r.source,
        album: r.album,
        ratings: [],
        isSingle: !!r.isSingle
      };
    }
    byRelease[key].ratings.push(r.final);
  });

  // Считаем средние
  const releasesList = Object.values(byRelease).map(g => {
    const sum = g.ratings.reduce((a, b) => a + b, 0);
    return {
      releaseId: g.releaseId,
      source: g.source,
      album: g.album,
      avg: Math.round(sum / g.ratings.length),
      count: g.ratings.length,
      isSingle: g.isSingle
    };
  });

  // ============================================================
  // 🏆 Альбом сезона — топ по средней среди НЕ-синглов
  // ============================================================
  const albumsOnly = releasesList
    .filter(r => !r.isSingle && r.count >= minRatings)
    .sort((a, b) => b.avg - a.avg || b.count - a.count);
  const albumOfSeason = albumsOnly[0] || null;

  // ============================================================
  // 💿 Сингл/EP сезона — топ по средней среди синглов
  // ============================================================
  const singlesOnly = releasesList
    .filter(r => r.isSingle && r.count >= minRatings)
    .sort((a, b) => b.avg - a.avg || b.count - a.count);
  const singleOfSeason = singlesOnly[0] || null;

  // ============================================================
  // 🎤 Артист сезона — средняя по всем его релизам в сезоне
  // ============================================================
  const byArtist = {};
  releasesList.forEach(r => {
    const artist = r.album && r.album.artist;
    if (!artist) return;
    if (!byArtist[artist]) byArtist[artist] = { name: artist, releases: [] };
    byArtist[artist].releases.push(r);
  });
  const artistList = Object.values(byArtist).map(a => {
    const totalWeighted = a.releases.reduce((sum, r) => sum + r.avg * r.count, 0);
    const totalCount = a.releases.reduce((sum, r) => sum + r.count, 0);
    return {
      name: a.name,
      avg: Math.round(totalWeighted / totalCount),
      count: totalCount,
      releaseCount: a.releases.length
    };
  }).filter(a => a.count >= minRatings)
    .sort((a, b) => b.avg - a.avg || b.count - a.count);
  const artistOfSeason = artistList[0] || null;

  // ============================================================
  // ⭐ Выбор критиков — макс число оценок среди тех, у кого avg >= 300
  // ============================================================
  const criticsCandidates = releasesList
    .filter(r => r.count >= minRatings && r.avg >= 300)
    .sort((a, b) => b.count - a.count || b.avg - a.avg);
  const criticsChoice = criticsCandidates[0] || null;

  // ============================================================
  // 🌍 Выбор сообщества — макс число оценок в сезоне,
  //     независимо от даты выхода релиза
  // ============================================================
  // Пересчитываем, но без фильтра по дате релиза, зато
  // с фильтром по дате оценки (внутри сезона).
  const startMs = season.startedAt?.seconds
    ? season.startedAt.seconds * 1000
    : new Date(season.startedAt).getTime();
  const endMs = season.endsAt?.seconds
    ? season.endsAt.seconds * 1000
    : new Date(season.endsAt).getTime();

  const ratingsInPeriod = allRatings.filter(r => {
    const ts = (r.ts?.seconds || 0) * 1000;
    return ts >= startMs && ts <= endMs;
  });

  const byReleaseCommunity = {};
  ratingsInPeriod.forEach(r => {
    const key = r.source + "_" + r.releaseId;
    if (!byReleaseCommunity[key]) {
      byReleaseCommunity[key] = {
        releaseId: r.releaseId,
        source: r.source,
        album: r.album,
        count: 0,
        sum: 0
      };
    }
    byReleaseCommunity[key].count++;
    byReleaseCommunity[key].sum += r.final;
  });
  const communityList = Object.values(byReleaseCommunity)
    .map(g => ({
      releaseId: g.releaseId,
      source: g.source,
      album: g.album,
      avg: Math.round(g.sum / g.count),
      count: g.count
    }))
    .filter(r => r.count >= minRatings)
    .sort((a, b) => b.count - a.count || b.avg - a.avg);
  const communityChoice = communityList[0] || null;

  // ============================================================
  // Собираем всё вместе
  // ============================================================
  return {
    albumOfSeason: albumOfSeason,
    singleOfSeason: singleOfSeason,
    artistOfSeason: artistOfSeason,
    criticsChoice: criticsChoice,
    communityChoice: communityChoice,
    minRatingsUsed: minRatings,
    totalRatingsInSeason: totalRatingsInSeason,
    computedAt: new Date()
  };
}