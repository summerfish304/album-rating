import { db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp } from './firebase.js';
import {
  ADMIN_UID, EMOJI_AVATARS, SCHEMES, ACHIEVEMENTS,
  XP_REWARDS, NOW_PLAYING_TTL
} from './config.js';
import {
  getLevelByXp, getTier, escapeHtml, colorFromString, plural, formatTime
} from './utils.js';
import { showToast } from './ui.js';
import { applyScheme, saveSchemeLocally } from './theme.js';
import { spotifySearchAlbums, mapSpotifyAlbum } from './search.js';
import { formatReviewText } from './board.js';
import { showConfirm } from './confirm.js';
import {
  loadMyArtistRatings,
  deleteMyArtistRating
} from './artists.js';
import {
  subscribeToUser, unsubscribeFromUser, isFollowing, getSubscriptionCounts
} from './board.js';
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

    // Подписки: счётчики + кнопка
    const counts = await getSubscriptionCounts(uid);
    const alreadyFollowing = isFollowing(uid);
    html += '<div class="user-profile-stats" style="margin-top:12px;">' +
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + counts.followers + '</div>' +
        '<div class="ups-lbl">Подписчики</div>' +
      '</div>' +
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + counts.following + '</div>' +
        '<div class="ups-lbl">Подписки</div>' +
      '</div>' +
    '</div>';

    html += '<div class="user-profile-actions" style="margin-top:16px;">';
    if (isMe) {
      html += '<button class="btn-secondary" onclick="closeUserProfile();switchNav(\'profile\')">👤 Открыть мой профиль</button>';
    } else {
      html += '<button class="' + (alreadyFollowing ? 'btn-secondary' : '') + '" data-follow-uid="' + escapeHtml(uid) + '" data-following="' + (alreadyFollowing ? '1' : '0') + '">' +
        (alreadyFollowing ? '✓ Вы подписаны' : '➕ Подписаться') +
      '</button>';
      html += '<button class="btn-secondary" onclick="closeUserProfile();openCompareWithUser(\'' + uid + '\')">⚖ Сравнить с моими</button>';
    }
    html += '<button class="btn-secondary" onclick="closeUserProfile()">Закрыть</button>';
    html += '</div>';

    content.innerHTML = html;

    // Обработчик кнопки подписки
    const followBtn = content.querySelector('[data-follow-uid]');
    if (followBtn) {
      followBtn.onclick = async () => {
        const targetUid = followBtn.dataset.followUid;
        const isFollowingNow = followBtn.dataset.following === "1";
        followBtn.disabled = true;
        if (isFollowingNow) {
          const ok = await unsubscribeFromUser(targetUid);
          if (ok) {
            followBtn.dataset.following = "0";
            followBtn.classList.add("btn-secondary");
            followBtn.textContent = "➕ Подписаться";
            // обновим счётчик подписчиков
            const statsEls = content.querySelectorAll(".user-profile-stat .ups-num");
            if (statsEls[0]) statsEls[0].textContent = Math.max(0, (parseInt(statsEls[0].textContent) || 1) - 1);
          }
        } else {
          const ok = await subscribeToUser(targetUid);
          if (ok) {
            followBtn.dataset.following = "1";
            followBtn.classList.remove("btn-secondary");
            followBtn.textContent = "✓ Вы подписаны";
            const statsEls = content.querySelectorAll(".user-profile-stat .ups-num");
            if (statsEls[0]) statsEls[0].textContent = (parseInt(statsEls[0].textContent) || 0) + 1;
          }
        }
        followBtn.disabled = false;
      };
    }

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

// Перерисовка открытой модалки профиля (вызывается из board.js после подписки)
if (typeof window !== "undefined") {
  window.__refreshOpenUserProfile = () => {
    const uid = _userProfileViewUid;
    if (uid) {
      const backdrop = document.getElementById("userProfileBackdrop");
      if (backdrop && backdrop.classList.contains("open")) {
        openUserProfile(uid, callbacks.onOpenRelease ? { onOpenRelease: callbacks.onOpenRelease } : {});
      }
    }
  };
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

// ============================================================
// ЛИЧНЫЕ ИТОГИ СЕЗОНА
// ============================================================

// Переключение вкладок профиля
export function switchProfileTab(tab) {
  document.querySelectorAll(".profile-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  document.querySelectorAll(".profile-section").forEach(s => {
    s.classList.toggle("hidden", s.dataset.section !== tab);
  });
  if (tab === "stats") renderProfileStatsTab();
  if (tab === "artists") renderMyArtistsTab();
  if (tab === "reviews") renderMyReviewsTab();
  if (tab === "achievements") renderAchievements();
  if (tab === "summary") renderProfileSummaryTab();
}

// ============================================================
// Вкладка СТАТИСТИКА — расширенная аналитика
// ============================================================
function renderProfileStatsTab() {
  const el = document.getElementById("profileStatsTab");
  if (!el) return;

  if (!myRatings || myRatings.length === 0) {
    el.innerHTML = '<div class="empty-msg" style="padding:24px 14px;">' +
      '<div style="font-size:2rem; margin-bottom:8px; opacity:.6;">📊</div>' +
      'Пока нет оценок.<br>' +
      '<span style="font-size:.8rem; color:var(--text-dim);">Оцените первый релиз — и здесь появится аналитика.</span>' +
    '</div>';
    return;
  }

  let html = '';

  // 1. Ваш стиль (5 чипов) — идёт первым, это самое интересное
  html += renderMyStyleBlock();

  // 2. Гистограмма по тирам
  html += renderTierHistogram();

  // 3. Динамика по месяцам
  html += renderMonthlyDynamics();

  // 4. Дополнительные цифры
  html += renderFunFacts();

  // 5. Топ-20 артистов
  html += renderTopArtistsExpanded();

  // 6. Топ-10 / антитоп-10
  html += renderTop10Block();

  el.innerHTML = html;

  // Навешиваем кнопку «Показать все 20»
  const expandBtn = document.getElementById("topArtistsExpandBtn");
  if (expandBtn) {
    expandBtn.onclick = () => {
      const hidden = document.querySelectorAll("#topArtistsList .top10-item.extra-item");
      const isHidden = hidden.length > 0 && hidden[0].classList.contains("hidden");
      hidden.forEach(it => it.classList.toggle("hidden", !isHidden));
      expandBtn.textContent = isHidden ? "Скрыть ▴" : "Показать все 20 ▾";
    };
  }

  // Клики по релизам в топ-10
  el.querySelectorAll(".top10-item[data-release-id]").forEach(item => {
    item.onclick = () => {
      const src = item.dataset.source;
      const rid = item.dataset.releaseId;
      if (callbacks.onSwitchNav) callbacks.onSwitchNav("board");
      const group = callbacks.onGetBoardData
        ? callbacks.onGetBoardData().find(b => b.source === src && b.releaseId === String(rid))
        : null;
      if (group && callbacks.onOpenBoardModal) {
        setTimeout(() => callbacks.onOpenBoardModal(group), 250);
      }
    };
  });
}

// ============================================================
// 1. «Ваш стиль» — 5 чипов
// ============================================================
function renderMyStyleBlock() {
  const ratings = myRatings;
  const n = ratings.length;
  const avgFinal = Math.round(ratings.reduce((a, r) => a + r.final, 0) / n);

  // Строгость
  let strictness, strictnessEmoji, strictnessColor;
  if (avgFinal >= 240) { strictness = "Щедрый"; strictnessEmoji = "🎁"; strictnessColor = "var(--accent-3)"; }
  else if (avgFinal >= 170) { strictness = "Сбалансированный"; strictnessEmoji = "⚖️"; strictnessColor = "var(--text)"; }
  else { strictness = "Строгий"; strictnessEmoji = "🔍"; strictnessColor = "var(--vibe-1)"; }

  // Широта
  const artistCounts = {};
  ratings.forEach(r => {
    const a = r.album && r.album.artist;
    if (a) artistCounts[a] = (artistCounts[a] || 0) + 1;
  });
  const uniqueArtists = Object.keys(artistCounts).length;
  const diversityRatio = uniqueArtists / n;
  let breadth, breadthEmoji;
  if (diversityRatio >= 0.85) { breadth = "Эклектик"; breadthEmoji = "🌍"; }
  else if (diversityRatio >= 0.5) { breadth = "Исследователь"; breadthEmoji = "🧭"; }
  else { breadth = "Фанат"; breadthEmoji = "❤️"; }

  // Глубина: альбомы vs синглы
  const albumsCount = ratings.filter(r => !r.isSingle).length;
  const singlesCount = ratings.filter(r => r.isSingle).length;
  const albumShare = n ? albumsCount / n : 0;
  let depth, depthEmoji;
  if (albumShare >= 0.65) { depth = "Альбомщик"; depthEmoji = "💿"; }
  else if (albumShare >= 0.3) { depth = "Универсал"; depthEmoji = "🎵"; }
  else { depth = "Сингловый"; depthEmoji = "🎼"; }

  // Тщательность: доля оценок с details
  const detailedCount = ratings.filter(r => r.details && Object.keys(r.details).length > 0).length;
  const detailedShare = detailedCount / n;
  let thoroughness, thoroughnessEmoji;
  if (detailedShare >= 0.5) { thoroughness = "Детальный"; thoroughnessEmoji = "📝"; }
  else if (detailedShare >= 0.2) { thoroughness = "Средний"; thoroughnessEmoji = "✏️"; }
  else { thoroughness = "Быстрый"; thoroughnessEmoji = "⚡"; }

  // Вайб-ориентированность: средний overall
  const withVibe = ratings.filter(r => r.overall != null);
  const avgVibe = withVibe.length
    ? (withVibe.reduce((a, r) => a + r.overall, 0) / withVibe.length).toFixed(1)
    : null;
  let vibeTrait, vibeEmoji;
  if (avgVibe == null) { vibeTrait = "—"; vibeEmoji = "🌌"; }
  else if (avgVibe >= 7.5) { vibeTrait = "Вайб-мастер"; vibeEmoji = "🌌"; }
  else if (avgVibe >= 5) { vibeTrait = "Сбалансированный"; vibeEmoji = "🌗"; }
  else { vibeTrait = "Критериальный"; vibeEmoji = "📐"; }

  const chip = (emoji, label, value, sub, color) =>
    '<div class="style-chip">' +
      '<div class="style-chip-icon">' + emoji + '</div>' +
      '<div class="style-chip-body">' +
        '<div class="style-chip-label">' + label + '</div>' +
        '<div class="style-chip-value" style="color:' + (color || "var(--text)") + '">' + escapeHtml(value) + '</div>' +
        (sub ? '<div class="style-chip-sub">' + escapeHtml(sub) + '</div>' : '') +
      '</div>' +
    '</div>';

  return '<div class="stats-section">' +
    '<div class="stats-section-title">✨ Ваш стиль</div>' +
    '<div class="style-grid">' +
      chip(strictnessEmoji, "Строгость", strictness, "средний " + avgFinal, strictnessColor) +
      chip(breadthEmoji, "Широта", breadth, uniqueArtists + " артистов", null) +
      chip(depthEmoji, "Глубина", depth, albumsCount + " альб / " + singlesCount + " сингл", null) +
      chip(thoroughnessEmoji, "Тщательность", thoroughness, detailedCount + " подробных", null) +
      '<div class="style-chip style-chip-wide">' +
        '<div class="style-chip-icon">' + vibeEmoji + '</div>' +
        '<div class="style-chip-body">' +
          '<div class="style-chip-label">Вайб-ориентированность</div>' +
          '<div class="style-chip-value">' + escapeHtml(vibeTrait) + '</div>' +
          (avgVibe != null ? '<div class="style-chip-sub">средний вайб ' + avgVibe + ' / 10</div>' : '') +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// ============================================================
// 2. Гистограмма по тирам
// ============================================================
function renderTierHistogram() {
  const bins = [
    { name: "Уголь",   emoji: "⚫", cssClass: "tier-coal",    min: 0,   max: 45,  color: "#4a4a4a" },
    { name: "Бронза",  emoji: "🥉", cssClass: "tier-bronze",  min: 45,  max: 90,  color: "#c07a4b" },
    { name: "Серебро", emoji: "⚪", cssClass: "tier-silver",  min: 90,  max: 135, color: "#9e9e9e" },
    { name: "Золото",  emoji: "🏅", cssClass: "tier-gold",    min: 135, max: 180, color: "#e8a91c" },
    { name: "Платина", emoji: "💠", cssClass: "tier-plat",    min: 180, max: 225, color: "#a8d8ea" },
    { name: "Рубин",   emoji: "🔴", cssClass: "tier-ruby",    min: 225, max: 270, color: "#ff5e5e" },
    { name: "Алмаз",   emoji: "💎", cssClass: "tier-diamond", min: 270, max: 315, color: "#b9f2ff" },
    { name: "Бриллиант", emoji: "👑", cssClass: "tier-brill", min: 315, max: 361, color: "#ffd700" }
  ];

  const counts = bins.map(b => ({
    ...b,
    count: myRatings.filter(r => r.final >= b.min && r.final < b.max).length
  }));
  const maxCount = Math.max(...counts.map(c => c.count), 1);
  const total = myRatings.length;

  let barsHtml = '<div class="tier-histogram">';
  counts.forEach(b => {
    const h = b.count === 0 ? 4 : Math.max(10, (b.count / maxCount) * 100);
    barsHtml += '<div class="th-col" title="' + escapeHtml(b.name) + ': ' + b.count + '">' +
      '<div class="th-count">' + (b.count || "") + '</div>' +
      '<div class="th-bar" style="height:' + h + 'px; background:' + b.color + ';"></div>' +
      '<div class="th-label">' + b.emoji + '</div>' +
    '</div>';
  });
  barsHtml += '</div>';

  return '<div class="stats-section">' +
    '<div class="stats-section-title">📊 Распределение по тирам</div>' +
    '<div class="stats-section-sub">Всего ' + total + ' ' + plural(total, "оценка", "оценки", "оценок") + '</div>' +
    barsHtml +
  '</div>';
}

// ============================================================
// 3. Динамика по месяцам
// ============================================================
function renderMonthlyDynamics() {
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"),
      label: d.toLocaleDateString("ru-RU", { month: "short" }),
      year: d.getFullYear(),
      month: d.getMonth(),
      count: 0,
      sumFinal: 0
    });
  }
  const map = {};
  months.forEach(m => map[m.key] = m);

  myRatings.forEach(r => {
    if (!r.ts?.seconds) return;
    const d = new Date(r.ts.seconds * 1000);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    if (map[key]) {
      map[key].count++;
      map[key].sumFinal += r.final;
    }
  });

  const maxCount = Math.max(...months.map(m => m.count), 1);
  let barsHtml = '<div class="month-bars">';
  months.forEach(m => {
    const h = m.count === 0 ? 4 : Math.max(10, (m.count / maxCount) * 100);
    const avg = m.count ? Math.round(m.sumFinal / m.count) : 0;
    barsHtml += '<div class="mb-col" title="' + escapeHtml(m.label) + ' ' + m.year + ': ' + m.count + ' оценок, средний ' + (avg || "—") + '">' +
      '<div class="mb-count">' + (m.count || "") + '</div>' +
      '<div class="mb-bar" style="height:' + h + 'px;"></div>' +
      '<div class="mb-label">' + escapeHtml(m.label) + '</div>' +
    '</div>';
  });
  barsHtml += '</div>';

  const totalInYear = months.reduce((a, m) => a + m.count, 0);
  return '<div class="stats-section">' +
    '<div class="stats-section-title">📈 Динамика за год</div>' +
    '<div class="stats-section-sub">' + totalInYear + ' ' + plural(totalInYear, "оценка", "оценки", "оценок") + ' за 12 месяцев</div>' +
    barsHtml +
  '</div>';
}

// ============================================================
// 4. Дополнительные цифры (fun facts)
// ============================================================
function renderFunFacts() {
  const facts = [];

  // Любимый год
  const yearCounts = {};
  myRatings.forEach(r => {
    const rd = r.album && r.album.releaseDate;
    if (rd) {
      const y = parseInt(rd.slice(0, 4));
      if (!isNaN(y)) yearCounts[y] = (yearCounts[y] || 0) + 1;
    }
  });
  const favYear = Object.entries(yearCounts).sort((a, b) => b[1] - a[1])[0];
  if (favYear) facts.push({ emoji: "📅", label: "Любимый год", value: favYear[0], sub: favYear[1] + " релизов" });

  // Артист с наибольшей средней (мин 2 релиза)
  const artistStats = {};
  myRatings.forEach(r => {
    const a = r.album && r.album.artist;
    if (!a) return;
    if (!artistStats[a]) artistStats[a] = { count: 0, sum: 0 };
    artistStats[a].count++;
    artistStats[a].sum += r.final;
  });
  const bestArtist = Object.entries(artistStats)
    .filter(([_, v]) => v.count >= 2)
    .map(([name, v]) => ({ name, avg: Math.round(v.sum / v.count), count: v.count }))
    .sort((a, b) => b.avg - a.avg)[0];
  if (bestArtist) facts.push({ emoji: "🎤", label: "Лучший артист", value: bestArtist.name, sub: "средняя " + bestArtist.avg });

  // Самый «щедрый» месяц (по средней)
  const monthAvg = {};
  myRatings.forEach(r => {
    if (!r.ts?.seconds) return;
    const d = new Date(r.ts.seconds * 1000);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    if (!monthAvg[key]) monthAvg[key] = { count: 0, sum: 0 };
    monthAvg[key].count++;
    monthAvg[key].sum += r.final;
  });
  const generous = Object.entries(monthAvg)
    .filter(([_, v]) => v.count >= 3)
    .map(([key, v]) => ({ key, avg: Math.round(v.sum / v.count), count: v.count }))
    .sort((a, b) => b.avg - a.avg)[0];
  if (generous) {
    const [y, m] = generous.key.split("-");
    const monthName = new Date(parseInt(y), parseInt(m) - 1, 1)
      .toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
    facts.push({ emoji: "💝", label: "Щедрый месяц", value: monthName, sub: "средняя " + generous.avg });
  }

  // Самый частый трек-балл 10
  let tens = 0;
  myRatings.forEach(r => { if (r.scores) r.scores.forEach(s => { if (s === 10) tens++; }); });
  if (tens > 0) facts.push({ emoji: "🔟", label: "Идеальных треков", value: String(tens), sub: "поставлено десяток" });

  if (facts.length === 0) return "";

  let html = '<div class="stats-section">' +
    '<div class="stats-section-title">💡 Забавные цифры</div>' +
    '<div class="fun-facts-grid">';
  facts.forEach(f => {
    html += '<div class="fun-fact">' +
      '<div class="ff-icon">' + f.emoji + '</div>' +
      '<div class="ff-body">' +
        '<div class="ff-label">' + escapeHtml(f.label) + '</div>' +
        '<div class="ff-value">' + escapeHtml(f.value) + '</div>' +
        '<div class="ff-sub">' + escapeHtml(f.sub) + '</div>' +
      '</div>' +
    '</div>';
  });
  html += '</div></div>';
  return html;
}

// ============================================================
// 5. Топ-20 артистов (расширенный)
// ============================================================
function renderTopArtistsExpanded() {
  const byArtist = {};
  myRatings.forEach(r => {
    const a = r.album && r.album.artist;
    if (!a) return;
    if (!byArtist[a]) byArtist[a] = { count: 0, sum: 0, best: null };
    byArtist[a].count++;
    byArtist[a].sum += r.final;
    if (!byArtist[a].best || r.final > byArtist[a].best.final) byArtist[a].best = r;
  });

  const list = Object.entries(byArtist)
    .map(([name, v]) => ({
      name,
      count: v.count,
      avg: Math.round(v.sum / v.count),
      best: v.best
    }))
    .sort((a, b) => b.count - a.count || b.avg - a.avg)
    .slice(0, 20);

  if (list.length === 0) {
    return '<div class="stats-section">' +
      '<div class="stats-section-title">🎤 Топ артистов</div>' +
      '<div class="empty-msg" style="padding:16px;">Пока нет данных</div>' +
    '</div>';
  }

  let html = '<div class="stats-section">' +
    '<div class="stats-section-title">🎤 Топ артистов</div>' +
    '<div class="stats-section-sub">' + list.length + ' ' + plural(list.length, "артист", "артиста", "артистов") + ', отсортировано по количеству</div>' +
    '<div class="top10-list" id="topArtistsList">';

  list.forEach((a, i) => {
    const tier = getTier(a.avg);
    const coverUrl = a.best && a.best.album && a.best.album.artwork ? a.best.album.artwork : "";
    const isExtra = i >= 10;
    html += '<div class="top10-item' + (isExtra ? ' extra-item hidden' : '') + '">' +
      '<div class="t10-num">' + (i + 1) + '</div>' +
      (coverUrl
        ? '<img src="' + escapeHtml(coverUrl) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="t10-noart">🎤</div>') +
      '<div class="t10-info">' +
        '<div class="t10-title">' + escapeHtml(a.name) + '</div>' +
        '<div class="t10-artist">' + a.count + ' ' + plural(a.count, "релиз", "релиза", "релизов") + ' · средняя ' + a.avg + '</div>' +
      '</div>' +
      '<div class="t10-score" style="color:' + tier.color + '">' + tier.emoji + '</div>' +
    '</div>';
  });
  html += '</div>';

  if (list.length > 10) {
    html += '<button class="btn-secondary btn-sm" id="topArtistsExpandBtn" style="margin-top:10px;">Показать все ' + list.length + ' ▾</button>';
  }

  html += '</div>';
  return html;
}

// ============================================================
// 6. Топ-10 / антитоп-10
// ============================================================
function renderTop10Block() {
  if (myRatings.length < 2) return "";
  const sorted = [...myRatings].sort((a, b) => b.final - a.final);
  const top10 = sorted.slice(0, 10);
  const anti10 = sorted.slice(-10).reverse();
  return '<div class="stats-section">' +
    '<div class="stats-section-title">🏆 Лучшие и худшие</div>' +
    '<div class="top10-grid">' +
      buildTop10Column("🏆 Топ-10 лучших", top10) +
      buildTop10Column("💀 Антитоп-10", anti10) +
    '</div>' +
  '</div>';
}

// ============================================================
// Вкладка ИТОГИ — сезонные
// ============================================================
export async function renderProfileSummaryTab() {
  const el = document.getElementById("profileSummary");
  if (!el) return;

  el.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';

  const currentSeason = callbacks.getCurrentSeason ? callbacks.getCurrentSeason() : null;
  const history = callbacks.getSeasonHistory ? callbacks.getSeasonHistory() : [];

  let html = '';

  // --- ТЕКУЩИЙ СЕЗОН ---
  if (currentSeason) {
    html += '<div class="summary-season-header">' +
      '<span class="summary-season-emoji">' + (currentSeason.emoji || "🎵") + '</span>' +
      '<span class="summary-season-title">' + escapeHtml(currentSeason.name || "Сезон") + ' ' + escapeHtml(String(currentSeason.year || "")) + '</span>' +
      '<span class="summary-season-badge">идёт</span>' +
    '</div>';

    const mySummary = await computeMySeasonSummary(currentSeason);
    html += renderMySeasonSummary(mySummary, currentSeason);
  } else {
    html += '<div class="empty-msg" style="padding:24px 14px;">' +
      '<div style="font-size:2rem; margin-bottom:8px; opacity:.6;">🎵</div>' +
      'Сезон ещё не запущен.<br>' +
      '<span style="font-size:.8rem; color:var(--text-dim);">Когда админ запустит сезон, здесь появятся ваши личные итоги.</span>' +
    '</div>';
  }

  // --- АРХИВ ---
  if (history.length > 0) {
    html += '<div class="summary-archive-header">📜 Архив сезонов</div>';
    for (const season of history.slice().reverse()) {
      html += await renderArchiveSeason(season);
    }
  }

  el.innerHTML = html;
}

// ============================================================
// Подсчёт личной статистики юзера за сезон
// ============================================================
async function computeMySeasonSummary(season) {
  // myRatings — уже в контексте, приходит через setProfileContext
  if (!myRatings.length) return null;
  if (!season || !season.startedAt || !season.endsAt) return null;

  const startMs = season.startedAt?.seconds ? season.startedAt.seconds * 1000 : new Date(season.startedAt).getTime();
  const endMs = season.endsAt?.seconds ? season.endsAt.seconds * 1000 : new Date(season.endsAt).getTime();

  // Фильтруем мои оценки, сделанные в период сезона
  const myRatingsInSeason = myRatings.filter(r => {
    const ts = (r.ts?.seconds || 0) * 1000;
    return ts >= startMs && ts <= endMs;
  });

  if (!myRatingsInSeason.length) return null;

  // Фильтруем релизы, вышедшие в сезоне
  const isReleaseInSeason = (r) => {
    const releaseDate = r.album?.releaseDate;
    if (!releaseDate) return false;
    const parts = releaseDate.split("-");
    const year = parseInt(parts[0]);
    const month = parts[1] ? parseInt(parts[1]) - 1 : 0;
    const day = parts[2] ? parseInt(parts[2]) : 1;
    const releaseMs = new Date(year, month, day).getTime();
    if (isNaN(releaseMs)) return false;
    return releaseMs >= startMs && releaseMs <= endMs;
  };

  const myReleasesInSeason = myRatingsInSeason.filter(isReleaseInSeason);

  // 🏆 Мой альбом сезона
  const myAlbums = myReleasesInSeason.filter(r => !r.isSingle);
  myAlbums.sort((a, b) => b.final - a.final);
  const myAlbumOfSeason = myAlbums[0] || null;

  // 💿 Мой сингл сезона
  const mySingles = myReleasesInSeason.filter(r => r.isSingle);
  mySingles.sort((a, b) => b.final - a.final);
  const mySingleOfSeason = mySingles[0] || null;

  // 🎤 Мой артист сезона
  const byArtist = {};
  myReleasesInSeason.forEach(r => {
    const a = r.album && r.album.artist;
    if (!a) return;
    if (!byArtist[a]) byArtist[a] = { name: a, sum: 0, count: 0, bestRelease: null };
    byArtist[a].sum += r.final;
    byArtist[a].count++;
    if (!byArtist[a].bestRelease || r.final > byArtist[a].bestRelease.final) {
      byArtist[a].bestRelease = r;
    }
  });
  const myArtistList = Object.values(byArtist)
    .map(a => ({ name: a.name, avg: Math.round(a.sum / a.count), count: a.count, bestRelease: a.bestRelease }))
    .sort((a, b) => b.avg - a.avg || b.count - a.count);
  const myArtistOfSeason = myArtistList[0] || null;

  // 🔥 Моё открытие сезона — артист, которого я впервые оценил в этом сезоне
  // "Впервые" — значит до начала сезона у меня не было оценок его релизов
  const myAllRatingsBeforeSeason = myRatings.filter(r => {
    const ts = (r.ts?.seconds || 0) * 1000;
    return ts < startMs;
  });
  const artistsBeforeSeason = new Set();
  myAllRatingsBeforeSeason.forEach(r => {
    const a = r.album && r.album.artist;
    if (a) artistsBeforeSeason.add(a);
  });

  const newArtistsInSeason = myArtistList.filter(a => !artistsBeforeSeason.has(a.name));
  const myDiscovery = newArtistsInSeason[0] || null;

  // 📈 Мои цифры
  const ratingsCount = myRatingsInSeason.length;
  const avgFinal = Math.round(myRatingsInSeason.reduce((s, r) => s + r.final, 0) / myRatingsInSeason.length);

  return {
    myAlbumOfSeason,
    mySingleOfSeason,
    myArtistOfSeason,
    myDiscovery,
    ratingsCount,
    avgFinal,
    season
  };
}

// ============================================================
// Рендер личных итогов
// ============================================================
function renderMySeasonSummary(summary, season) {
  if (!summary) {
    return '<div class="empty-msg" style="padding:20px 14px; font-size:.85rem;">' +
      'В этом сезоне вы пока не оценили ни одного релиза.' +
    '</div>';
  }

  const blocks = [];

  if (summary.myAlbumOfSeason) {
    blocks.push(renderAwardCard("🏆 Мой альбом сезона", summary.myAlbumOfSeason, "album"));
  }
  if (summary.mySingleOfSeason) {
    blocks.push(renderAwardCard("💿 Мой сингл сезона", summary.mySingleOfSeason, "single"));
  }
  if (summary.myArtistOfSeason) {
    blocks.push(renderArtistCard("🎤 Мой артист сезона", summary.myArtistOfSeason));
  }
  if (summary.myDiscovery && summary.myDiscovery.name !== summary.myArtistOfSeason?.name) {
    blocks.push(renderArtistCard("🔥 Моё открытие сезона", summary.myDiscovery, true));
  }

  // Цифры
  blocks.push(renderMyNumbers(summary));

  return '<div class="summary-grid">' + blocks.join("") + '</div>';
}

// ============================================================
// Карточка награды с обложкой
// ============================================================
function renderAwardCard(title, rating, type) {
  if (!rating || !rating.album) return "";
  const tier = getTier(rating.final);
  return '<div class="summary-award-card">' +
    '<div class="sac-title">' + title + '</div>' +
    '<div class="sac-body">' +
      (rating.album.artwork
        ? '<img class="sac-cover" src="' + escapeHtml(rating.album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="sac-cover sac-cover-noart">💿</div>') +
      '<div class="sac-info">' +
        '<div class="sac-album-title">' + escapeHtml(rating.album.title || "—") + '</div>' +
        '<div class="sac-album-artist">' + escapeHtml(rating.album.artist || "—") + '</div>' +
        '<div class="sac-tier">' + tier.emoji + ' ' + escapeHtml(tier.name) + '</div>' +
      '</div>' +
      '<div class="sac-score" style="color:' + tier.color + '">' + rating.final + '</div>' +
    '</div>' +
  '</div>';
}

// ============================================================
// Карточка артиста (без обложки релиза)
// ============================================================
function renderArtistCard(title, artist, isDiscovery) {
  if (!artist) return "";
  const tier = getTier(artist.avg);
  const icon = isDiscovery ? "🔥" : "🎤";
  return '<div class="summary-award-card">' +
    '<div class="sac-title">' + title + '</div>' +
    '<div class="sac-body">' +
      '<div class="sac-artist-icon">' + icon + '</div>' +
      '<div class="sac-info">' +
        '<div class="sac-album-title">' + escapeHtml(artist.name) + '</div>' +
        '<div class="sac-album-artist">' + artist.count + ' ' + plural(artist.count, "оценка", "оценки", "оценок") + '</div>' +
        '<div class="sac-tier">' + tier.emoji + ' ' + escapeHtml(tier.name) + '</div>' +
      '</div>' +
      '<div class="sac-score" style="color:' + tier.color + '">' + artist.avg + '</div>' +
    '</div>' +
  '</div>';
}

// ============================================================
// Карточка «Мои цифры»
// ============================================================
function renderMyNumbers(summary) {
  return '<div class="summary-award-card summary-numbers">' +
    '<div class="sac-title">📈 Мои цифры</div>' +
    '<div class="summary-numbers-grid">' +
      '<div class="sng-item"><div class="sng-num">' + summary.ratingsCount + '</div><div class="sng-lbl">оценок</div></div>' +
      '<div class="sng-item"><div class="sng-num">' + summary.avgFinal + '</div><div class="sng-lbl">средний балл</div></div>' +
    '</div>' +
  '</div>';
}

// ============================================================
// Архив сезона: мои итоги + глобальные победители
// ============================================================
async function renderArchiveSeason(season) {
  const summary = await computeMySeasonSummary(season);
  const globalAwards = season.awards || null;

  let html = '<div class="archive-season-card">' +
    '<div class="arc-header">' +
      '<span class="arc-emoji">' + (season.emoji || "🎵") + '</span>' +
      '<span class="arc-title">' + escapeHtml(season.name || "Сезон") + ' ' + escapeHtml(String(season.year || "")) + '</span>' +
      '<span class="arc-badge">завершён</span>' +
    '</div>';

  // Мои итоги
  if (summary) {
    html += '<div class="arc-subtitle">🏅 Ваши итоги</div>';
    html += '<div class="arc-mine">';
    if (summary.myAlbumOfSeason) {
      html += renderMiniAward("🏆 Альбом", summary.myAlbumOfSeason);
    }
    if (summary.mySingleOfSeason) {
      html += renderMiniAward("💿 Сингл", summary.mySingleOfSeason);
    }
    if (summary.myArtistOfSeason) {
      html += '<div class="arc-mini arc-mini-artist">' +
        '<div class="arc-mini-label">🎤 Артист</div>' +
        '<div class="arc-mini-name">' + escapeHtml(summary.myArtistOfSeason.name) + '</div>' +
        '<div class="arc-mini-score">' + summary.myArtistOfSeason.avg + '</div>' +
      '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="arc-mine-empty">Вы не оценивали релизы в этом сезоне.</div>';
  }

  // Глобальные победители
  if (globalAwards) {
    html += '<div class="arc-subtitle" style="margin-top:14px;">🌐 Итоги всех юзеров</div>';
    html += '<div class="arc-global">';
    if (globalAwards.albumOfSeason) {
      html += renderGlobalAward("🏆 Альбом сезона", globalAwards.albumOfSeason);
    }
    if (globalAwards.singleOfSeason) {
      html += renderGlobalAward("💿 Сингл сезона", globalAwards.singleOfSeason);
    }
    if (globalAwards.artistOfSeason) {
      html += '<div class="arc-global-item arc-global-artist">' +
        '<div class="agi-title">🎤 Артист сезона</div>' +
        '<div class="agi-name">' + escapeHtml(globalAwards.artistOfSeason.name) + '</div>' +
        '<div class="agi-score">' + globalAwards.artistOfSeason.avg + '</div>' +
      '</div>';
    }
    if (globalAwards.criticsChoice) {
      html += renderGlobalAward("⭐ Выбор критиков", globalAwards.criticsChoice);
    }
    if (globalAwards.communityChoice) {
      html += renderGlobalAward("🌍 Выбор сообщества", globalAwards.communityChoice);
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderMiniAward(label, rating) {
  if (!rating || !rating.album) return "";
  const tier = getTier(rating.final);
  return '<div class="arc-mini">' +
    '<div class="arc-mini-label">' + label + '</div>' +
    '<div class="arc-mini-name">' + escapeHtml(rating.album.title || "") + '</div>' +
    '<div class="arc-mini-score" style="color:' + tier.color + '">' + rating.final + '</div>' +
  '</div>';
}

function renderGlobalAward(label, item) {
  if (!item) return "";
  const tier = getTier(item.avg || 0);
  return '<div class="arc-global-item">' +
    '<div class="agi-cover-wrap">' +
      (item.album?.artwork
        ? '<img class="agi-cover" src="' + escapeHtml(item.album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="agi-cover agi-cover-noart">💿</div>') +
    '</div>' +
    '<div class="agi-info">' +
      '<div class="agi-title">' + label + '</div>' +
      '<div class="agi-name">' + escapeHtml(item.album?.title || "—") + '</div>' +
      '<div class="agi-artist">' + escapeHtml(item.album?.artist || "") + '</div>' +
    '</div>' +
    '<div class="agi-score" style="color:' + tier.color + '">' + (item.avg || 0) + '</div>' +
  '</div>';
}

// ============================================================
// Вкладка «МОИ РЕЦЕНЗИИ»
// ============================================================
export async function renderMyReviewsTab() {
  const el = document.getElementById("myReviewsList");
  const countEl = document.getElementById("myReviewsCount");
  if (!el) return;

  el.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';

  if (!currentUser) {
    el.innerHTML = '<div class="empty-msg">Нужно войти в аккаунт.</div>';
    return;
  }

  try {
    const q = query(
      collection(db, "reviews"),
      where("uid", "==", currentUser.uid)
    );
    const snap = await getDocs(q);
    let reviews = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    reviews.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));

    if (countEl) countEl.textContent = reviews.length ? "(" + reviews.length + ")" : "";

    if (reviews.length === 0) {
      el.innerHTML =
        '<div class="reviews-empty">' +
          '<div class="reviews-empty-icon">📝</div>' +
          '<div class="reviews-empty-text">Вы пока не написали ни одной рецензии.<br>Оцените релиз и напишите своё мнение.</div>' +
        '</div>';
      return;
    }

    el.innerHTML = "";
    reviews.forEach(r => {
      el.appendChild(buildMyReviewCard(r));
    });
  } catch (e) {
    el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

function buildMyReviewCard(review) {
  const el = document.createElement("div");
  el.className = "my-review-card";

  const album = review.album || {};
  const time = review.ts?.seconds ? formatTime(review.ts.seconds) : "";
  const edited = review.editedAt ? ' <span class="review-edited">(изм.)</span>' : '';

  el.innerHTML =
    '<div class="mrc-album-row">' +
      (album.artwork
        ? '<img class="mrc-cover" src="' + escapeHtml(album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="mrc-cover mrc-noart">💿</div>') +
      '<div class="mrc-album-info">' +
        '<div class="mrc-album-title">' + escapeHtml(album.title || "—") + '</div>' +
        '<div class="mrc-album-artist">' + escapeHtml(album.artist || "") + '</div>' +
      '</div>' +
      '<div class="mrc-time">' + time + edited + '</div>' +
    '</div>' +
    '<div class="mrc-text">' + formatReviewText(review.text || "") + '</div>' +
    '<div class="mrc-actions">' +
      '<button class="review-action-btn mrc-open-btn">👁 Открыть на доске</button>' +
      '<button class="review-action-btn review-delete-btn mrc-delete-btn">🗑 Удалить</button>' +
    '</div>';

  // Открыть на доске
  const openBtn = el.querySelector(".mrc-open-btn");
  if (openBtn) {
    openBtn.onclick = () => {
      if (callbacks.onSwitchNav) callbacks.onSwitchNav("board");
      const group = callbacks.onGetBoardData
        ? callbacks.onGetBoardData().find(b => b.source === review.source && b.releaseId === String(review.releaseId))
        : null;
      if (group && callbacks.onOpenBoardModal) {
        setTimeout(() => callbacks.onOpenBoardModal(group), 300);
      } else {
        showToast("Релиз пока не на доске");
      }
    };
  }

  // Удалить
  const delBtn = el.querySelector(".mrc-delete-btn");
  if (delBtn) {
    delBtn.onclick = () => deleteMyReview(review._id);
  }

  return el;
}

async function deleteMyReview(reviewId) {
  const ok = await showConfirm({
    icon: "🗑",
    title: "Удалить рецензию?",
    text: "Рецензию нельзя восстановить.",
    okText: "Удалить",
    okClass: "btn-danger"
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "reviews", reviewId));
    showToast("Рецензия удалена", { success: true });
    renderMyReviewsTab();
  } catch (e) { showToast("Ошибка: " + e.message); }
}
// ============================================================
// ВКЛАДКА «МОИ АРТИСТЫ»
// ============================================================
export async function renderMyArtistsTab() {
  const el = document.getElementById("myArtistsList");
  const countEl = document.getElementById("myArtistsCount");
  if (!el) return;

  el.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';

  if (!currentUser) {
    el.innerHTML = '<div class="empty-msg">Нужно войти в аккаунт.</div>';
    return;
  }

  try {
    const ratings = await loadMyArtistRatings();
    if (countEl) countEl.textContent = ratings.length ? "(" + ratings.length + ")" : "";

    if (ratings.length === 0) {
      el.innerHTML =
        '<div class="reviews-empty">' +
          '<div class="reviews-empty-icon">🎤</div>' +
          '<div class="reviews-empty-text">Вы пока не оценили ни одного артиста.<br>Найдите артиста через поиск и поставьте оценку по 5 критериям.</div>' +
        '</div>';
      return;
    }

    el.innerHTML = "";
    ratings.forEach(r => {
      el.appendChild(buildMyArtistCard(r));
    });
  } catch (e) {
    el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

function buildMyArtistCard(rating) {
  const el = document.createElement("div");
  el.className = "my-artist-card";

  const tier = getTier(rating.final);
  const time = rating.ts?.seconds ? formatTime(rating.ts.seconds) : "";
  const artistName = rating.artist?.name || "—";
  const artistPhoto = rating.artist?.photo || "";

  el.innerHTML =
    (artistPhoto
      ? '<img class="mac-photo" src="' + escapeHtml(artistPhoto) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
      : '<div class="mac-photo mac-noimg">🎤</div>') +
    '<div class="mac-info">' +
      '<div class="mac-name">' + escapeHtml(artistName) + '</div>' +
      '<div class="mac-meta">' +
        '<span class="mac-tier" style="color:' + tier.color + '">' + tier.emoji + ' ' + escapeHtml(tier.name) + '</span>' +
        '<span class="mac-time">' + time + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="mac-score" style="color:' + tier.color + '">' + rating.final + '</div>' +
    '<div class="mac-actions">' +
      '<button class="review-action-btn mac-open-btn" title="Открыть артиста">👁</button>' +
      '<button class="review-action-btn review-delete-btn mac-del-btn" title="Удалить оценку">🗑</button>' +
    '</div>';

  // Открыть артиста
  const openBtn = el.querySelector(".mac-open-btn");
  if (openBtn) {
    openBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (callbacks.onSwitchNav) callbacks.onSwitchNav("main");
      if (callbacks.onOpenArtist) {
        setTimeout(() => callbacks.onOpenArtist(rating.artistId), 250);
      }
    };
  }

  // Удалить
  const delBtn = el.querySelector(".mac-del-btn");
  if (delBtn) {
    delBtn.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await showConfirm({
        icon: "🗑",
        title: "Удалить оценку артиста?",
        text: "Оценка «" + artistName + "» будет удалена.",
        okText: "Удалить",
        okClass: "btn-danger"
      });
      if (!ok) return;
      await deleteMyArtistRating(rating.artistId);
      showToast("Оценка удалена", { success: true });
      renderMyArtistsTab();
    };
  }

  // Клик по карточке = открыть артиста
  el.onclick = () => {
    if (callbacks.onSwitchNav) callbacks.onSwitchNav("main");
    if (callbacks.onOpenArtist) {
      setTimeout(() => callbacks.onOpenArtist(rating.artistId), 250);
    }
  };

  return el;
}