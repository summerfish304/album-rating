import { db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp } from './firebase.js';
import {
  ADMIN_UID, EMOJI_AVATARS, SCHEMES, ACHIEVEMENTS,
  XP_REWARDS, NOW_PLAYING_TTL
} from './config.js';
import {
  getLevelByXp, getTier, escapeHtml, colorFromString, plural
} from './utils.js';
import { showToast } from './ui.js';
import { applyScheme, saveSchemeLocally } from './theme.js';
import { spotifySearchAlbums, mapSpotifyAlbum } from './search.js';

// ============================================================
// Контекст (устанавливается из main.js)
// ============================================================
let currentUser = null;
let userProfile = null;
let myRatings = [];
let userAchievements = new Set();
let compareSelection = [];
let nowPlayingSuggestions = [];
let nowPlayingDebounce = null;
let _userProfileViewUid = null;
let callbacks = {};

export function setProfileContext(opts) {
  if (opts.currentUser !== undefined) currentUser = opts.currentUser;
  if (opts.userProfile !== undefined) userProfile = opts.userProfile;
  if (opts.myRatings !== undefined) myRatings = opts.myRatings;
  if (opts.userAchievements !== undefined) userAchievements = opts.userAchievements;
  if (opts.callbacks !== undefined) callbacks = opts.callbacks || {};
}
export function getUserAchievements() { return userAchievements; }

// ============================================================
// Профиль
// ============================================================
export function renderProfile() {
  if (!userProfile) return;
  const isAdmin = currentUser && currentUser.uid === ADMIN_UID;

  const levelCard = document.getElementById("levelCard");
  const achievementsHeader = document.getElementById("achievementsHeader");
  const achievementsGrid = document.getElementById("achievementsGrid");
  const adminBadgeBox = document.getElementById("adminBadgeBox");

  if (isAdmin) {
    if (levelCard) levelCard.classList.add("hidden");
    if (achievementsHeader) achievementsHeader.classList.add("hidden");
    if (achievementsGrid) achievementsGrid.classList.add("hidden");
    if (adminBadgeBox) adminBadgeBox.classList.remove("hidden");
  } else {
    if (levelCard) levelCard.classList.remove("hidden");
    if (achievementsHeader) achievementsHeader.classList.remove("hidden");
    if (achievementsGrid) achievementsGrid.classList.remove("hidden");
    if (adminBadgeBox) adminBadgeBox.classList.add("hidden");
  }

  const avatarToShow = isAdmin ? "💎" : (userProfile.avatar || "🎵");
  document.getElementById("profileAvatarBig").textContent = avatarToShow;
  document.getElementById("profileNickInput").value = userProfile.nickname || "";
  const grid = document.getElementById("emojiGrid");
  grid.innerHTML = "";

  const emojiLabel = document.getElementById("emojiLabel");
  const adminAvatarNote = document.getElementById("adminAvatarNote");
  if (emojiLabel) emojiLabel.style.display = isAdmin ? "none" : "";
  if (grid) grid.style.display = isAdmin ? "none" : "";
  if (adminAvatarNote) adminAvatarNote.classList.toggle("hidden", !isAdmin);

  const ADMIN_AVATARS = ["👑", "💎", "🪄", "🎩"];
  const availableEmojis = EMOJI_AVATARS.filter(e => !ADMIN_AVATARS.includes(e));
  availableEmojis.forEach(e => {
    const btn = document.createElement("button");
    btn.className = "emoji-cell" + (e === (userProfile.avatar || "🎵") ? " active" : "");
    btn.textContent = e;
    btn.onclick = () => selectAvatar(e);
    grid.appendChild(btn);
  });

  // --- Переключатель темы: своя / сезонная ---
  renderThemeModeSwitcher();

  const schemeGrid = document.getElementById("schemeGrid");
  schemeGrid.innerHTML = "";
  SCHEMES.forEach(s => {
    const btn = document.createElement("button");
    btn.className = "scheme-cell" + (s.id === (userProfile.scheme || "default") ? " active" : "");
    btn.innerHTML = '<div class="sc-preview ' + s.preview + '"></div><div class="sc-name">' + s.name + '</div>';
    btn.onclick = () => selectScheme(s.id);
    schemeGrid.appendChild(btn);
  });

  const stats = document.getElementById("profileStats");
  if (!myRatings.length) {
    stats.innerHTML = "";
    setTimeout(renderProfileStatsInner, 150);
  } else {
    renderProfileStatsInner();
  }

  if (callbacks.onUpdateLevelUI) callbacks.onUpdateLevelUI();
  renderNowPlayingSection();
  renderTopArtists();
  renderTop10();
  renderAchievements();
}

function renderProfileStatsInner() {
  const stats = document.getElementById("profileStats");
  if (!stats) return;
  const avgFinal = myRatings.length ? Math.round(myRatings.reduce((a, r) => a + r.final, 0) / myRatings.length) : 0;
  const tier = avgFinal ? getTier(avgFinal) : null;
  const favArtist = getFavoriteArtist();
  const ratingsWithCover = myRatings.filter(r => r.coverRating);
  const avgCover = ratingsWithCover.length
    ? (ratingsWithCover.reduce((a, r) => a + r.coverRating, 0) / ratingsWithCover.length).toFixed(1)
    : "—";
  stats.innerHTML =
    '<div class="profile-stat"><div class="num">' + myRatings.length + '</div>Оценок</div>' +
    '<div class="profile-stat"><div class="num">' + (avgFinal || "—") + '</div>Средний балл</div>' +
    '<div class="profile-stat"><div class="num">' + (tier ? tier.emoji : "—") + '</div>' + (tier ? tier.name : "Уровень") + '</div>' +
    '<div class="profile-stat"><div class="num">' + avgCover + '</div>Средняя обложка</div>' +
    '<div class="profile-stat"><div class="num">' + (favArtist || "—") + '</div>Любимый артист</div>';
}

export function getFavoriteArtist() {
  if (myRatings.length === 0) return null;
  const byArtist = {};
  myRatings.forEach(r => {
    const a = r.album && r.album.artist;
    if (!a) return;
    byArtist[a] = (byArtist[a] || 0) + 1;
  });
  const entries = Object.entries(byArtist).sort((a, b) => b[1] - a[1]);
  return entries[0] ? entries[0][0] : null;
}

async function selectAvatar(emoji) {
  if (!currentUser) return;
  const isAdmin = currentUser.uid === ADMIN_UID;
  const ADMIN_AVATARS = ["👑", "💎", "🪄", "🎩"];
  if (ADMIN_AVATARS.includes(emoji) && !isAdmin) {
    showToast("Эта аватарка только для админа");
    return;
  }
  try {
    await updateDoc(doc(db, "users", currentUser.uid), { avatar: emoji });
    userProfile.avatar = emoji;
    document.getElementById("profileAvatarBig").textContent = emoji;
    document.querySelectorAll(".emoji-cell").forEach(el => el.classList.toggle("active", el.textContent === emoji));
    if (callbacks.onUpdateUserChip) callbacks.onUpdateUserChip();
    showToast("Аватар обновлён", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}

async function selectScheme(schemeId) {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), { scheme: schemeId });
    userProfile.scheme = schemeId;
    applyScheme(schemeId);
    saveSchemeLocally(schemeId);
    document.querySelectorAll(".scheme-cell").forEach((el, i) => el.classList.toggle("active", SCHEMES[i].id === schemeId));
    showToast("Схема обновлена", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export async function saveNickname() {
  if (!currentUser) return;
  const newNick = document.getElementById("profileNickInput").value.trim();
  if (!newNick || newNick.length < 2) { showToast("Ник слишком короткий"); return; }
  if (newNick.toLowerCase() === (userProfile.nicknameLower || "")) { showToast("Это ваш текущий ник"); return; }
  try {
    const newRef = doc(db, "nicknames", newNick.toLowerCase());
    const snap = await getDoc(newRef);
    if (snap.exists() && snap.data().uid !== currentUser.uid) { showToast("Ник уже занят"); return; }
    if (userProfile.nicknameLower) {
      try { await deleteDoc(doc(db, "nicknames", userProfile.nicknameLower)); } catch (e) {}
    }
    await setDoc(newRef, { uid: currentUser.uid });
    await updateDoc(doc(db, "users", currentUser.uid), { nickname: newNick, nicknameLower: newNick.toLowerCase() });
    userProfile.nickname = newNick;
    userProfile.nicknameLower = newNick.toLowerCase();
    if (callbacks.onUpdateUserChip) callbacks.onUpdateUserChip();
    showToast("Ник обновлён", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ============================================================
// Слушаю сейчас
// ============================================================
export function renderNowPlayingSection() {
  const el = document.getElementById("nowPlayingSection");
  if (!el) return;
  const np = userProfile && userProfile.nowPlaying;
  const isFresh = np && np.ts && (Date.now() - (np.ts.seconds ? np.ts.seconds * 1000 : 0) < NOW_PLAYING_TTL);
  let html = '<div class="history-header" style="margin-top:20px;"><h2>🎧 Сейчас слушаю</h2></div>';
  if (isFresh) {
    html += '<div class="now-playing">' +
      '<img src="' + escapeHtml(np.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="np-info">' +
        '<div class="np-label">Слушает сейчас</div>' +
        '<div class="np-title">' + escapeHtml(np.title || "") + '</div>' +
        '<div class="np-artist">' + escapeHtml(np.artist || "") + '</div>' +
      '</div>' +
      '<button class="np-clear" onclick="clearNowPlaying()">Убрать</button>' +
    '</div>';
  }
  html += '<button class="btn-secondary btn-sm" onclick="openNowPlayingPicker()">' + (isFresh ? "🎧 Сменить" : "🎧 Указать что слушаю") + '</button>';
  el.innerHTML = html;
}

export async function openNowPlayingPicker() {
  if (!currentUser) { showToast("Нужно войти"); return; }
  document.getElementById("nowPlayingBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
  document.getElementById("nowPlayingSearch").value = "";
  document.getElementById("nowPlayingSuggestions").innerHTML = "";
  document.getElementById("nowPlayingSuggestions").classList.remove("open");
  setTimeout(() => document.getElementById("nowPlayingSearch").focus(), 150);
}

export function closeNowPlayingPicker() {
  document.getElementById("nowPlayingBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}

export function onNowPlayingSearchInput() {
  const q = document.getElementById("nowPlayingSearch").value.trim();
  clearTimeout(nowPlayingDebounce);
  const listEl = document.getElementById("nowPlayingSuggestions");
  if (q.length < 2) { listEl.classList.remove("open"); return; }
  listEl.innerHTML = '<div class="status"><span class="spinner"></span> Поиск…</div>';
  listEl.classList.add("open");
  nowPlayingDebounce = setTimeout(async () => {
    try {
      const albums = await spotifySearchAlbums(q, 10);
      const items = albums.map(mapSpotifyAlbum);
      if (items.length === 0) {
        listEl.innerHTML = '<div class="status">Ничего не найдено</div>';
        return;
      }
      nowPlayingSuggestions = items.slice(0, 10);
      listEl.innerHTML = "";
      nowPlayingSuggestions.forEach((album, i) => {
        const el = document.createElement("div");
        el.className = "suggestion";
        el.innerHTML = '<img src="' + escapeHtml(album.cover) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
          '<div class="text"><div class="t">' + escapeHtml(album.title) + '</div><div class="a">' + escapeHtml(album.artist) + '</div></div>';
        el.onmousedown = (e) => { e.preventDefault(); chooseNowPlaying(i); };
        listEl.appendChild(el);
      });
      listEl.classList.add("open");
    } catch (e) {
      listEl.innerHTML = '<div class="status">Ошибка поиска</div>';
    }
  }, 400);
}

export function onNowPlayingKeydown(e) {
  if (e.key === "Escape") closeNowPlayingPicker();
}

async function chooseNowPlaying(i) {
  const album = nowPlayingSuggestions[i];
  if (!album || !currentUser) return;
  closeNowPlayingPicker();
  try {
    await updateDoc(doc(db, "users", currentUser.uid), {
      nowPlaying: {
        id: album.id,
        title: album.title,
        artist: album.artist,
        artwork: album.cover,
        source: album.source,
        ts: serverTimestamp()
      }
    });
    userProfile.nowPlaying = {
      id: album.id, title: album.title, artist: album.artist,
      artwork: album.cover, source: album.source,
      ts: { seconds: Math.floor(Date.now() / 1000) }
    };
    renderNowPlayingSection();
    showToast("Слушаю сейчас обновлено", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export async function clearNowPlaying() {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), { nowPlaying: null });
    userProfile.nowPlaying = null;
    renderNowPlayingSection();
    showToast("Убрано");
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ============================================================
// Топ-5 артистов
// ============================================================
function renderTopArtists() {
  const el = document.getElementById("topArtists");
  if (!el) return;
  if (!myRatings.length) { el.innerHTML = '<div class="empty-msg" style="padding:20px;">Пока нет оценок</div>'; return; }
  const byArtist = {};
  myRatings.forEach(r => {
    const a = r.album && r.album.artist;
    if (!a) return;
    if (!byArtist[a]) byArtist[a] = { count: 0, sum: 0 };
    byArtist[a].count++;
    byArtist[a].sum += r.final;
  });
  const list = Object.entries(byArtist)
    .map(([artist, v]) => ({ artist, count: v.count, avg: Math.round(v.sum / v.count) }))
    .sort((a, b) => b.count - a.count || b.avg - a.avg)
    .slice(0, 5);
  if (list.length === 0) { el.innerHTML = '<div class="empty-msg" style="padding:20px;">Пока нет данных</div>'; return; }
  let html = '<div class="top10-list">';
  list.forEach((a, i) => {
    const tier = getTier(a.avg);
    html += '<div class="top10-item">' +
      '<div class="t10-num">' + (i + 1) + '</div>' +
      '<div class="t10-info"><div class="t10-title">' + escapeHtml(a.artist) + '</div>' +
      '<div class="t10-artist">' + a.count + ' ' + plural(a.count, "релиз", "релиза", "релизов") + ' · средняя ' + a.avg + '</div></div>' +
      '<div class="t10-score" style="color:' + tier.color + '">' + tier.emoji + '</div>' +
    '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

// ============================================================
// Топ-10 / антитоп-10
// ============================================================
function renderTop10() {
  const el = document.getElementById("top10Grid");
  if (!el) return;
  if (myRatings.length < 2) { el.innerHTML = '<div class="empty-msg" style="padding:20px;">Оцените хотя бы 2 релиза</div>'; return; }
  const sorted = [...myRatings].sort((a, b) => b.final - a.final);
  const top10 = sorted.slice(0, 10);
  const anti10 = sorted.slice(-10).reverse();
  el.innerHTML = buildTop10Column("🏆 Топ-10 лучших", top10) + buildTop10Column("💀 Антитоп-10", anti10);
}

function buildTop10Column(title, list) {
  let html = '<div class="top10-col"><h4>' + title + '</h4><div class="top10-list">';
  list.forEach((item, i) => {
    const tier = getTier(item.final);
    html += '<div class="top10-item" data-release-id="' + escapeHtml(String(item.releaseId)) + '" data-source="' + escapeHtml(item.source) + '">' +
      '<div class="t10-num">' + (i + 1) + '</div>' +
      (item.album.artwork ? '<img src="' + escapeHtml(item.album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '') +
      '<div class="t10-info"><div class="t10-title">' + escapeHtml(item.album.title) + '</div>' +
      '<div class="t10-artist">' + escapeHtml(item.album.artist) + '</div></div>' +
      '<div class="t10-score" style="color:' + tier.color + '">' + item.final + '</div>' +
    '</div>';
  });
  html += '</div></div>';
  return html;
}

// ============================================================
// Достижения
// ============================================================
export function renderAchievements() {
  const grid = document.getElementById("achievementsGrid");
  if (!grid) return;
  const earned = userAchievements;
  document.getElementById("achCount").textContent = earned.size + " / " + ACHIEVEMENTS.length;
  grid.innerHTML = "";
  ACHIEVEMENTS.forEach(a => {
    const isEarned = earned.has(a.id);
    const el = document.createElement("div");
    el.className = "achievement " + (isEarned ? "earned" : "locked");
    el.innerHTML = '<span class="ach-emoji">' + a.emoji + '</span>' +
      '<div class="ach-name">' + escapeHtml(a.name) + '</div>' +
      '<div class="ach-desc">' + escapeHtml(a.desc) + '</div>';
    el.title = a.desc;
    grid.appendChild(el);
  });
}

export async function checkAchievements(cb) {
  cb = cb || {};
  if (!currentUser || !userProfile) return;
  if (currentUser.uid === ADMIN_UID) return;
  const toUnlock = [];
  const unlocked = userAchievements;
  const totalRatings = myRatings.length;

  if (totalRatings >= 1 && !unlocked.has("first_step")) toUnlock.push("first_step");
  if (totalRatings >= 5 && !unlocked.has("listener")) toUnlock.push("listener");
  if (totalRatings >= 15 && !unlocked.has("melomaniac")) toUnlock.push("melomaniac");
  if (totalRatings >= 50 && !unlocked.has("collector")) toUnlock.push("collector");
  if (totalRatings >= 100 && !unlocked.has("maestro")) toUnlock.push("maestro");
  if (myRatings.some(r => getTier(r.final).name === "Бронза") && !unlocked.has("lvl_bronze")) toUnlock.push("lvl_bronze");
  if (myRatings.some(r => getTier(r.final).name === "Золото") && !unlocked.has("lvl_gold")) toUnlock.push("lvl_gold");
  if (myRatings.some(r => getTier(r.final).name === "Алмаз") && !unlocked.has("lvl_diamond")) toUnlock.push("lvl_diamond");
  if (myRatings.some(r => r.final >= 360) && !unlocked.has("lvl_brill")) toUnlock.push("lvl_brill");
  if (myRatings.some(r => getTier(r.final).name === "Уголь") && !unlocked.has("lvl_coal")) toUnlock.push("lvl_coal");

  const artistCounts = {};
  myRatings.forEach(r => {
    const a = r.album && r.album.artist;
    if (a) artistCounts[a] = (artistCounts[a] || 0) + 1;
  });
  const uniqueArtists = Object.keys(artistCounts).length;
  if (Object.values(artistCounts).some(n => n >= 3) && !unlocked.has("fan")) toUnlock.push("fan");
  if (Object.values(artistCounts).some(n => n >= 10) && !unlocked.has("superfan")) toUnlock.push("superfan");
  if (uniqueArtists >= 10 && !unlocked.has("traveler")) toUnlock.push("traveler");
  if (uniqueArtists >= 50 && !unlocked.has("cartographer")) toUnlock.push("cartographer");

  const hasAlbum = myRatings.some(r => !r.isSingle && r.scores && r.scores.length > 1);
  const hasSingle = myRatings.some(r => r.isSingle);
  if (hasAlbum && hasSingle && !unlocked.has("diverse")) toUnlock.push("diverse");

  const hasDetailed = myRatings.filter(r => r.details && Object.keys(r.details).length > 0).length;
  if (hasDetailed >= 10 && !unlocked.has("statistician")) toUnlock.push("statistician");

  const dayCounts = {};
  myRatings.forEach(r => {
    const day = r.ts?.seconds ? new Date(r.ts.seconds * 1000).toISOString().slice(0, 10) : null;
    if (day) dayCounts[day] = (dayCounts[day] || 0) + 1;
  });
  if (Object.values(dayCounts).some(n => n >= 5) && !unlocked.has("speedrun")) toUnlock.push("speedrun");
  if (myRatings.filter(r => r.final < 100).length >= 10 && !unlocked.has("critic")) toUnlock.push("critic");
  if (myRatings.filter(r => r.final > 300).length >= 10 && !unlocked.has("generous")) toUnlock.push("generous");
  if (myRatings.some(r => !r.details || Object.keys(r.details).length === 0) && totalRatings >= 3 && !unlocked.has("lazy")) toUnlock.push("lazy");

  let totalTens = 0;
  myRatings.forEach(r => { if (r.scores) r.scores.forEach(s => { if (s === 10) totalTens++; }); });
  if (totalTens >= 10 && !unlocked.has("perfectionist")) toUnlock.push("perfectionist");

  const tiersSeen = new Set(myRatings.map(r => getTier(r.final).name));
  if (tiersSeen.size >= 8 && !unlocked.has("all_colors")) toUnlock.push("all_colors");
  if (myRatings.some(r => r.final >= 360) && !unlocked.has("cosmos")) toUnlock.push("cosmos");
  if (myRatings.filter(r => r.final < 50).length >= 3 && !unlocked.has("antifan")) toUnlock.push("antifan");
  if (myRatings.filter(r => r.final >= 360).length >= 10 && !unlocked.has("brill_hunter")) toUnlock.push("brill_hunter");
  if (totalRatings >= 5 && myRatings.every(r => r.final > 162) && !unlocked.has("perfect_taste")) toUnlock.push("perfect_taste");
  if (totalRatings >= 5 && myRatings.every(r => r.final >= 100 && r.final <= 250) && !unlocked.has("fair")) toUnlock.push("fair");

  const hourNow = new Date().getHours();
  if (hourNow >= 0 && hourNow < 6 && !unlocked.has("night")) toUnlock.push("night");
  if (hourNow >= 6 && hourNow < 9 && !unlocked.has("early")) toUnlock.push("early");
  if (hourNow >= 5 && hourNow < 7 && !unlocked.has("dawn")) toUnlock.push("dawn");
  if (hourNow >= 20 && hourNow < 23 && !unlocked.has("evening")) toUnlock.push("evening");

  const loginDays = userProfile.loginDays || [];
  if (loginDays.length >= 7 && !unlocked.has("regular")) {
    const last7 = loginDays.slice(-7).sort();
    const consecutive = last7.every((d, i) => {
      if (i === 0) return true;
      const prev = new Date(last7[i - 1]);
      const cur = new Date(d);
      return Math.round((cur - prev) / 86400000) === 1;
    });
    if (consecutive) toUnlock.push("regular");
  }

  if (myRatings.some(r => r.final === 200 || r.final === 300) && !unlocked.has("round")) toUnlock.push("round");
  if (totalRatings === 100 && !unlocked.has("century")) toUnlock.push("century");

  const ratingsWithCover = myRatings.filter(r => r.coverRating);
  if (ratingsWithCover.filter(r => r.coverRating === 10).length >= 10 && !unlocked.has("aesthete")) toUnlock.push("aesthete");
  if (ratingsWithCover.length >= 10) {
    const avgCover = ratingsWithCover.reduce((a, r) => a + r.coverRating, 0) / ratingsWithCover.length;
    if (avgCover >= 8 && !unlocked.has("visualist")) toUnlock.push("visualist");
  }
  if (ratingsWithCover.filter(r => r.coverRating === 10).length >= 5 && !unlocked.has("photographer")) toUnlock.push("photographer");
  if (unlocked.size >= 40 && !unlocked.has("master")) toUnlock.push("master");
  if (myRatings.some(r => r.final === 42) && !unlocked.has("clown")) toUnlock.push("clown");
  if (myRatings.some(r => {
    const t = (r.album.title || "").toLowerCase();
    return t.includes("cat") || t.includes("кот") || t.includes("кош") || t.includes("kitty");
  }) && !unlocked.has("cat")) toUnlock.push("cat");
  if (myRatings.some(r => {
    const t = (r.album.title || "").toLowerCase();
    return /pizza|пицц|burger|бургер|sushi|суши|coffee|кофе|food|еда|taco|тако/.test(t);
  }) && !unlocked.has("pizza")) toUnlock.push("pizza");

  if (toUnlock.length > 0) {
    toUnlock.forEach(id => {
      unlocked.add(id);
      const ach = ACHIEVEMENTS.find(a => a.id === id);
      if (ach) {
        showAchievementToast(ach);
        if (cb.onAchievementPush) cb.onAchievementPush(ach);
      }
    });
    try {
      await updateDoc(doc(db, "users", currentUser.uid), { achievements: Array.from(unlocked) });
      userProfile.achievements = Array.from(unlocked);
    } catch (e) {}
    if (cb.onAddXp) await cb.onAddXp(toUnlock.length * XP_REWARDS.achievement, "Достижения");
    renderAchievements();
  }
}

export function showAchievementToast(ach) {
  const container = document.getElementById("achievementToasts");
  const el = document.createElement("div");
  el.className = "achievement-toast";
  el.innerHTML = '<span class="ach-icon">' + ach.emoji + '</span>' +
    '<div><div style="font-size:.72rem;opacity:.8;text-transform:uppercase;letter-spacing:.06em;">Достижение</div>' +
    '<div>' + escapeHtml(ach.name) + '</div></div>';
  container.appendChild(el);
  setTimeout(() => el.remove(), 4600);
}

// ============================================================
// Сравнение
// ============================================================
export function openCompareSelector() {
  compareSelection = [];
  document.getElementById("compareStage1").classList.remove("hidden");
  document.getElementById("compareStage2").classList.add("hidden");
  document.getElementById("compareCount").textContent = "0";
  document.getElementById("compareGoBtn").disabled = true;
  const listEl = document.getElementById("compareSelectList");
  if (myRatings.length < 2) {
    listEl.innerHTML = '<div class="empty-msg">Нужно минимум 2 оценённых релиза для сравнения.</div>';
  } else {
    listEl.innerHTML = "";
    myRatings.forEach(item => {
      const el = document.createElement("div");
      el.className = "compare-select-item";
      el.dataset.id = item._id;
      const tier = getTier(item.final);
      el.innerHTML = '<img src="' + escapeHtml(item.album.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="info"><div class="title">' + escapeHtml(item.album.title) + '</div>' +
        '<div class="artist">' + escapeHtml(item.album.artist) + ' · ' + tier.emoji + ' ' + item.final + '</div></div>';
      el.onclick = () => toggleCompareItem(el, item._id);
      listEl.appendChild(el);
    });
  }
  document.getElementById("compareModalBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}

function toggleCompareItem(el, id) {
  const idx = compareSelection.indexOf(id);
  if (idx >= 0) { compareSelection.splice(idx, 1); el.classList.remove("selected"); }
  else {
    if (compareSelection.length >= 2) { showToast("Максимум 2 релиза"); return; }
    compareSelection.push(id); el.classList.add("selected");
  }
  document.getElementById("compareCount").textContent = compareSelection.length;
  document.getElementById("compareGoBtn").disabled = compareSelection.length !== 2;
}

export function compareGo(cb) {
  cb = cb || {};
  if (compareSelection.length !== 2) return;
  const a = myRatings.find(r => r._id === compareSelection[0]);
  const b = myRatings.find(r => r._id === compareSelection[1]);
  if (!a || !b) return;
  document.getElementById("compareStage1").classList.add("hidden");
  document.getElementById("compareStage2").classList.remove("hidden");
  const tierA = getTier(a.final);
  const tierB = getTier(b.final);
  document.getElementById("compareResult").innerHTML =
    '<div class="compare-col ' + (a.final >= b.final ? "win" : "") + '">' +
      '<img src="' + escapeHtml(a.album.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="title">' + escapeHtml(a.album.title) + '</div>' +
      '<div class="artist">' + escapeHtml(a.album.artist) + '</div>' +
      '<div class="score-big" style="color:' + tierA.color + '">' + a.final + '</div>' +
      '<span class="tier-tag">' + tierA.emoji + ' ' + tierA.name + '</span></div>' +
    '<div class="compare-col ' + (a.final >= b.final ? "win" : "") + '">' +
      '<img src="' + escapeHtml(b.album.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="title">' + escapeHtml(b.album.title) + '</div>' +
      '<div class="artist">' + escapeHtml(b.album.artist) + '</div>' +
      '<div class="score-big" style="color:' + tierB.color + '">' + b.final + '</div>' +
      '<span class="tier-tag">' + tierB.emoji + ' ' + tierB.name + '</span></div>';
  const rows = [
    ["Итоговая оценка", a.final, b.final],
    ["Средняя треков", (a.avg || 0).toFixed(2), (b.avg || 0).toFixed(2)],
    ["Атмосфера / вайб", a.overall || "—", b.overall || "—"],
    ["Оценка обложки", a.coverRating || "—", b.coverRating || "—"],
    ["Количество треков", (a.scores || []).length, (b.scores || []).length]
  ];
  let html = '<thead><tr><th></th><th>' + escapeHtml(a.album.title.substring(0, 16)) + '</th><th>' + escapeHtml(b.album.title.substring(0, 16)) + '</th></tr></thead><tbody>';
  rows.forEach(([label, va, vb]) => {
    const numA = parseFloat(va), numB = parseFloat(vb);
    const winA = !isNaN(numA) && !isNaN(numB) && numA > numB;
    const winB = !isNaN(numA) && !isNaN(numB) && numB > numA;
    html += '<tr><td>' + label + '</td><td class="' + (winA ? "win" : "") + '">' + va + '</td><td class="' + (winB ? "win" : "") + '">' + vb + '</td></tr>';
  });
  html += "</tbody>";
  document.getElementById("compareTable").innerHTML = html;
  if (!userAchievements.has("comparer")) {
    userAchievements.add("comparer");
    updateDoc(doc(db, "users", currentUser.uid), { achievements: Array.from(userAchievements) }).catch(() => {});
    const ach = ACHIEVEMENTS.find(a => a.id === "comparer");
    if (ach) showAchievementToast(ach);
    if (cb.onAddXp) cb.onAddXp(XP_REWARDS.achievement, "Достижение");
  }
}

export function compareBack() {
  document.getElementById("compareStage1").classList.remove("hidden");
  document.getElementById("compareStage2").classList.add("hidden");
}

export function closeCompareModal() {
  document.getElementById("compareModalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}

// ============================================================
// Профиль другого юзера
// ============================================================
export async function openUserProfile(uid, cb) {
  cb = cb || {};
  if (!uid) return;
  _userProfileViewUid = uid;
  const modal = document.getElementById("userProfileBackdrop");
  const content = document.getElementById("userProfileContent");
  content.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';
  modal.classList.add("open");
  document.body.style.overflow = "hidden";
  try {
    const userSnap = await getDoc(doc(db, "users", uid));
    if (!userSnap.exists()) {
      content.innerHTML = '<div class="empty-msg">Пользователь не найден</div>';
      return;
    }
    const u = userSnap.data();
    const q = query(collection(db, "ratings"), where("uid", "==", uid));
    const snap = await getDocs(q);
    let ratings = snap.docs.map(d => ({ _id: d.id, ...d.data() })).filter(r => !r.hidden);
    ratings.sort((a, b) => b.final - a.final);

    const isAdmin = uid === ADMIN_UID;
    const isMe = currentUser && uid === currentUser.uid;
    const level = getLevelByXp(u.xp || 0);
    const avatarColor = colorFromString(u.nickname || "?");

    const albums = ratings.filter(r => !r.isSingle);
    const singles = ratings.filter(r => r.isSingle);

    const avgOf = arr => arr.length ? Math.round(arr.reduce((a, r) => a + r.final, 0) / arr.length) : 0;
    const avgAll = avgOf(ratings);
    const avgAlbums = avgOf(albums);
    const avgSingles = avgOf(singles);
    const tierAll = avgAll ? getTier(avgAll) : null;

    const top3 = ratings.slice(0, 3);
    const bottom3 = ratings.length > 3 ? ratings.slice(-3).reverse() : [];

    const artistCount = {};
    ratings.forEach(r => {
      const a = r.album && r.album.artist;
      if (a) artistCount[a] = (artistCount[a] || 0) + 1;
    });
    const favArtistEntry = Object.entries(artistCount).sort((a, b) => b[1] - a[1])[0];
    const favArtist = favArtistEntry ? { name: favArtistEntry[0], count: favArtistEntry[1] } : null;

    let html = '';
    html += '<div class="user-profile-header">' +
      '<div class="user-profile-avatar" style="background:' + avatarColor + '">' + escapeHtml(u.avatar || "🎵") +
        '<span class="mini-level">' + level.level + '</span>' +
      '</div>' +
      '<div class="user-profile-info">' +
        '<div class="user-profile-nick' + (isAdmin ? ' admin-nick' : '') + '">' + escapeHtml(u.nickname || "—") + (isAdmin ? ' 👑' : '') + '</div>' +
        '<div class="user-level-badge-line">' +
          (isAdmin
            ? '<span class="user-level-badge admin-user-badge">👑 Администратор</span>'
            : '<span class="user-level-badge">' + level.emoji + ' Уровень ' + level.level + ' · ' + level.name + '</span>') +
        '</div>' +
        '<div class="user-profile-meta">' +
          (favArtist ? '<span>🎤 Любимый артист: <b>' + escapeHtml(favArtist.name) + '</b> (' + favArtist.count + ' релизов)</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';

    if (u.nowPlaying && u.nowPlaying.ts) {
      const tsMs = u.nowPlaying.ts.seconds ? u.nowPlaying.ts.seconds * 1000 : 0;
      if (Date.now() - tsMs < NOW_PLAYING_TTL) {
        html += '<div class="now-playing">' +
          '<img src="' + escapeHtml(u.nowPlaying.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
          '<div class="np-info">' +
            '<div class="np-label">Слушает сейчас</div>' +
            '<div class="np-title">' + escapeHtml(u.nowPlaying.title || "") + '</div>' +
            '<div class="np-artist">' + escapeHtml(u.nowPlaying.artist || "") + '</div>' +
          '</div>' +
        '</div>';
      }
    }

    html += '<div class="user-profile-stats">' +
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + ratings.length + '</div>' +
        '<div class="ups-lbl">Всего оценок</div>' +
        '<div class="ups-sub">' + albums.length + ' альб · ' + singles.length + ' сингл</div>' +
      '</div>' +
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + (avgAll || "—") + '</div>' +
        '<div class="ups-lbl">Средний балл</div>' +
        (tierAll ? '<div class="ups-sub">' + tierAll.emoji + ' ' + tierAll.name + '</div>' : '<div class="ups-sub">—</div>') +
      '</div>' +
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + albums.length + '</div>' +
        '<div class="ups-lbl">Альбомов</div>' +
        '<div class="ups-sub">средний ' + (avgAlbums || "—") + '</div>' +
      '</div>' +
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + singles.length + '</div>' +
        '<div class="ups-lbl">Синглов</div>' +
        '<div class="ups-sub">средний ' + (avgSingles || "—") + '</div>' +
      '</div>' +
    '</div>';

    if (top3.length > 0) {
      html += '<div class="user-top-section">' +
        '<div class="user-top-header">🏆 Лучшие релизы</div>' +
        '<div class="user-top-list">';
      top3.forEach((item, i) => {
        const tier = getTier(item.final);
        const typeLabel = item.isSingle ? 'Сингл' : 'Альбом';
        html += '<div class="user-top-item" data-release-uid="' + escapeHtml(uid) + '" data-source="' + escapeHtml(item.source) + '" data-release-id="' + escapeHtml(String(item.releaseId)) + '">' +
          '<div class="uti-rank">' + (i + 1) + '</div>' +
          (item.album && item.album.artwork ? '<img src="' + escapeHtml(item.album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '<div class="uti-noart">💿</div>') +
          '<div class="uti-info">' +
            '<div class="uti-title">' + escapeHtml(item.album.title || "") + '</div>' +
            '<div class="uti-artist">' + escapeHtml(item.album.artist || "") + ' · <span style="opacity:.7">' + typeLabel + '</span></div>' +
          '</div>' +
          '<div class="uti-score" style="color:' + tier.color + '">' + item.final + '</div>' +
        '</div>';
      });
      html += '</div></div>';
    }

    if (bottom3.length > 0) {
      html += '<div class="user-top-section">' +
        '<div class="user-top-header">💀 Худшие релизы</div>' +
        '<div class="user-top-list">';
      bottom3.forEach((item) => {
        const tier = getTier(item.final);
        const typeLabel = item.isSingle ? 'Сингл' : 'Альбом';
        html += '<div class="user-top-item" data-release-uid="' + escapeHtml(uid) + '" data-source="' + escapeHtml(item.source) + '" data-release-id="' + escapeHtml(String(item.releaseId)) + '">' +
          '<div class="uti-rank">—</div>' +
          (item.album && item.album.artwork ? '<img src="' + escapeHtml(item.album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '<div class="uti-noart">💿</div>') +
          '<div class="uti-info">' +
            '<div class="uti-title">' + escapeHtml(item.album.title || "") + '</div>' +
            '<div class="uti-artist">' + escapeHtml(item.album.artist || "") + ' · <span style="opacity:.7">' + typeLabel + '</span></div>' +
          '</div>' +
          '<div class="uti-score" style="color:' + tier.color + '">' + item.final + '</div>' +
        '</div>';
      });
      html += '</div></div>';
    }

    html += '<div class="user-profile-actions" style="margin-top:16px;">';
    if (isMe) {
      html += '<button class="btn-secondary" onclick="closeUserProfile();switchNav(\'profile\')">👤 Открыть мой профиль</button>';
    } else {
      html += '<button class="btn-secondary" onclick="closeUserProfile();openCompareWithUser(\'' + uid + '\')">⚖ Сравнить с моими</button>';
    }
    html += '<button class="btn-secondary" onclick="closeUserProfile()">Закрыть</button>';
    html += '</div>';

    content.innerHTML = html;

    content.querySelectorAll(".user-top-item").forEach(el => {
      el.onclick = () => {
        const src = el.dataset.source;
        const rid = el.dataset.releaseId;
        closeUserProfile();
        if (cb.onOpenRelease) cb.onOpenRelease(src, rid);
      };
    });
  } catch (e) {
    content.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

export function closeUserProfile() {
  document.getElementById("userProfileBackdrop").classList.remove("open");
  document.body.style.overflow = "";
  _userProfileViewUid = null;
}

// ============================================================
// Переключатель темы: своя схема / сезон
// ============================================================
function renderThemeModeSwitcher() {
  const wrap = document.getElementById("themeModeSwitcher");
  if (!wrap) return;

  const hasSeason = callbacks.getCurrentSeason && callbacks.getCurrentSeason();
  const pref = callbacks.getThemePreference ? callbacks.getThemePreference() : "season";

  wrap.innerHTML =
    '<label>Тема оформления</label>' +
    '<div class="theme-mode-grid">' +
      '<button type="button" class="theme-mode-btn' + (pref === "own" ? " active" : "") + '" data-mode="own">' +
        '<span class="tm-icon">🎨</span>' +
        '<span class="tm-label">Своя схема</span>' +
      '</button>' +
      '<button type="button" class="theme-mode-btn' + (pref === "season" ? " active" : "") + (hasSeason ? "" : " disabled") + '" data-mode="season">' +
        '<span class="tm-icon">' + (hasSeason ? (hasSeason.emoji || "🍂") : "🚫") + '</span>' +
        '<span class="tm-label">Тема сезона</span>' +
        (hasSeason ? '' : '<span class="tm-note">Сезон ещё не запущен</span>') +
      '</button>' +
    '</div>' +
    '<div class="particles-toggle-row">' +
      '<label class="particles-toggle">' +
        '<input type="checkbox" id="particlesToggle" ' + (callbacks.isParticlesOff && callbacks.isParticlesOff() ? "" : "checked") + '>' +
        '<span>Анимированный фон</span>' +
      '</label>' +
    '</div>';

  wrap.querySelectorAll(".theme-mode-btn").forEach(btn => {
    btn.onclick = () => {
      const mode = btn.dataset.mode;
      if (mode === "season" && !hasSeason) {
        showToast("Сезон ещё не запущен");
        return;
      }
      selectThemeMode(mode);
    };
  });

  const pt = document.getElementById("particlesToggle");
  if (pt) {
    pt.onchange = () => {
      if (callbacks.setParticlesOff) callbacks.setParticlesOff(!pt.checked);
      // Мгновенно применяем изменения — перезапускаем/останавливаем частицы
      if (callbacks.applySeasonTheme) callbacks.applySeasonTheme();
      showToast(pt.checked ? "Фон включён" : "Фон отключён");
    };
  }
}

async function selectThemeMode(mode) {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), { seasonThemePreference: mode });
    userProfile.seasonThemePreference = mode;
    if (callbacks.setThemePreference) callbacks.setThemePreference(mode);
    renderThemeModeSwitcher();
    showToast(mode === "own" ? "Своя схема" : "Тема сезона", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export function openCompareWithUser(uid) {
  openCompareSelector();
}