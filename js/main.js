// ============================================================
// main.js — точка входа. Импорты, состояние, auth, init.
// ============================================================

import {
  app, auth, db,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged,
  collection, doc, setDoc, getDoc, getDocs,
  query, where, deleteDoc, serverTimestamp, addDoc, updateDoc,
  onSnapshot, orderBy, fbLimit
} from './firebase.js';

import {
  ADMIN_UID, XP_REWARDS, RATE_LIMIT_MS, RATE_LIMIT_HOUR,
  LS_RATING_TIMES, LS_REPORTS, NOW_PLAYING_TTL
} from './config.js';

import {
  getLevelByXp, getNextLevel, colorFromString
} from './utils.js';

import { showToast } from './ui.js';

import { showConfirm, closeConfirm } from './confirm.js';

import {
  applyScheme, saveSchemeLocally, loadSchemeLocally,
  initTheme, cycleTheme
} from './theme.js';

import {
  loadNotifications, updateNotifDot,
  openNotifications, closeNotifications
} from './notifications.js';

import {
  loadWishlist, updateWishlistBadge,
  addToWishlist, removeFromWishlist,
  renderWishlist, getRandomWishlistItem
} from './wishlist.js';

import {
  loadSiteSettingsOnce, subscribeSiteSettings,
  startMaintenancePolling, applyMaintenanceState, applyAnnouncementState,
  dismissAnnouncement, openMaintenanceModal, closeMaintenanceModal,
  saveMaintenanceSettings, toggleMaintenance, renderAdminMaintenance,
  getSiteSettings
} from './site-settings.js';

import {
  onSearchInput, onSearchKeydown,
  showSuggestions, closeSuggestions,
  renderSearchHistory, addToSearchHistory, clearSearchHistory,
  setSearchContext, renderFavorites, addToFavorites, removeFromFavorites,
  toggleFavoritesCollapse
} from './search.js';

import {
  setRatingsContext, getCurrentAlbum, getCurrentTracks, getMyRatings,
  loadAlbum, setRatingMode, initRatingMode,
  onCoverRatingChange, updateScore, toggleHistogram,
  openModal, closeModal, toggleHelp, toggleHelpSingle,
  rateTrackAsSingle, applyModalRating,
  submitRating, deleteMyRating, loadMyRatings, renderHistory, restoreFromMyRatings,
  saveDraft, clearDraft, checkDraftBanner, continueDraft, dismissDraft,
  reset, clearReviewInput
} from './ratings.js';

import {
  setBoardContext, getBoardData, getBoardModalRelease, getMyReportedComments,
  loadLocalReported, saveLocalReported,
  refreshBoard, renderBoard, renderBoardDynamicStats, onBoardSearchInput,
  openBoardModal, closeBoardModal,
  loadReviews, formatReviewText,
  switchTopTab, renderTops,
  subscribeFeed, refreshFeed, renderFeed, renderHotToday,
  loadMySubscriptions, subscribeToUser, unsubscribeFromUser
} from './board.js';

import {
  setProfileContext,
  renderProfile, saveNickname,
  renderNowPlayingSection, openNowPlayingPicker, closeNowPlayingPicker,
  onNowPlayingSearchInput, onNowPlayingKeydown, clearNowPlaying,
  checkAchievements,
  openCompareSelector, compareGo, compareBack, closeCompareModal,
  openUserProfile, closeUserProfile, openCompareWithUser,
  switchProfileTab, renderProfileSummaryTab
} from './profile.js';

import {
  setAdminContext,
  renderAdmin, switchAdminTab,
  openBanModal, closeBanModal, selectBanDuration, confirmBanUser,
  resetUserProgress, unbanUser,
  approveSuggestion, rejectSuggestion, deleteSuggestion,
  createRelease,
  adminEditRelease, closeEditRelease, saveEditRelease, resetEditRelease,
  adminDeleteReleaseFromBoard,
  publishAnnouncement, deleteAnnouncement,
  adminJumpToComment,
  adminDeleteReportedReview, clearReviewReports,
  renderAdminReviews, adminDeleteReviewManually,
  adminOpenStartSeasonModal, adminCloseStartSeasonModal,
  adminSelectSeasonType, adminUpdateSeasonYear,
  adminConfirmStartSeason, adminFinishSeason,
  adminDeleteSeasonFromHistory, renderAdminSeasons,
  adminRecountAwards
} from './admin.js';

import {
  setSeasonContext,
  loadSeasonOnce, subscribeSeason,
  getCurrentSeason, getSeasonHistory,
  applySeasonTheme, renderSeasonBanner, renderFinishedSeasonBanner,
  setUserScheme, setThemePreference, loadThemePreferenceFromLocal,
  getThemePreference,
  switchRatingsTab, renderSeasonsArchive
} from './season.js';

import {
  setArtistsContext,
  openArtist, closeArtistPage, openAlbumFromArtist,
  openArtistRatingForm, closeArtistRatingForm, applyArtistRating,
  toggleArtistHelp, searchArtists
} from './artists.js';

import {
  setRecommendationsContext,
  loadRecommendations,
  refreshRecommendations,
  refreshRandomReco,
  setRecommendationsVisible
} from './recommendations.js';

import { isParticlesOff, setParticlesOff } from './season-particles.js';

import { computeSeasonAwards } from './season-awards.js';

// ============================================================
// Состояние main.js
// ============================================================
let currentUser = null;
let userProfile = null;
let userAchievements = new Set();
let currentNav = "main";
let swipeStartX = 0;
let swipeStartY = 0;
let authMode = "login";
let _lastNav = "main";
const NAV_ORDER = ["main", "board", "tops", "history", "wishlist", "profile", "admin"];

// ============================================================
// Rate limit (общий для всех)
// ============================================================
function rateLimitCheck() {
  try {
    const times = JSON.parse(localStorage.getItem(LS_RATING_TIMES) || "[]");
    const now = Date.now();
    const recent = times.filter(t => now - t < 60000);
    if (recent.length >= RATE_LIMIT_HOUR) {
      return { ok: false, reason: "Слишком много оценок за час. Попробуйте позже." };
    }
    if (times.length > 0 && (now - times[times.length - 1]) < RATE_LIMIT_MS) {
      const wait = Math.ceil((RATE_LIMIT_MS - (now - times[times.length - 1])) / 1000);
      return { ok: false, reason: "Подождите " + wait + " сек. перед следующей оценкой" };
    }
    return { ok: true };
  } catch (e) { return { ok: true }; }
}
function rateLimitRegister() {
  try {
    const times = JSON.parse(localStorage.getItem(LS_RATING_TIMES) || "[]");
    times.push(Date.now());
    if (times.length > 50) times.splice(0, times.length - 50);
    localStorage.setItem(LS_RATING_TIMES, JSON.stringify(times));
  } catch (e) {}
}

// ============================================================
// Авторизация
// ============================================================
function toggleAuthMode() {
  authMode = authMode === "login" ? "register" : "login";
  const isReg = authMode === "register";
  document.getElementById("authTitle").textContent = isReg ? "Регистрация" : "Вход";
  document.getElementById("authSubtitle").textContent = isReg
    ? "Создайте аккаунт, чтобы сохранять оценки"
    : "Войдите, чтобы сохранять оценки и видеть доску";
  document.getElementById("authSubmitBtn").textContent = isReg ? "Зарегистрироваться" : "Войти";
  document.getElementById("authSwitchText").textContent = isReg ? "Уже есть аккаунт?" : "Нет аккаунта?";
  document.getElementById("authSwitchBtn").textContent = isReg ? "Войти" : "Зарегистрироваться";
  document.getElementById("authNick").classList.toggle("hidden", !isReg);
  document.getElementById("authError").textContent = "";
}

async function handleAuthSubmit() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const nick = document.getElementById("authNick").value.trim();
  const errEl = document.getElementById("authError");
  const btn = document.getElementById("authSubmitBtn");
  errEl.textContent = "";
  if (!email || !password) { errEl.textContent = "Заполните email и пароль"; return; }
  if (authMode === "register" && !nick) { errEl.textContent = "Введите никнейм"; return; }
  if (authMode === "register" && nick.length < 2) { errEl.textContent = "Ник слишком короткий"; return; }
  if (password.length < 6) { errEl.textContent = "Пароль минимум 6 символов"; return; }
  btn.disabled = true;
  try {
    if (authMode === "register") {
      const nickRef = doc(db, "nicknames", nick.toLowerCase());
      const nickSnap = await getDoc(nickRef);
      if (nickSnap.exists()) { errEl.textContent = "Такой ник уже занят"; btn.disabled = false; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await setDoc(doc(db, "users", cred.user.uid), {
        nickname: nick, nicknameLower: nick.toLowerCase(), email: email,
        avatar: "🎵", achievements: [], xp: 0, scheme: "default",
        createdAt: serverTimestamp(), lastLogin: serverTimestamp(), loginDays: []
      });
      await setDoc(nickRef, { uid: cred.user.uid });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (e) {
    errEl.textContent = translateAuthError(e.code) || e.message;
  } finally { btn.disabled = false; }
}

function translateAuthError(code) {
  const map = {
    "auth/email-already-in-use": "Этот email уже зарегистрирован",
    "auth/invalid-email": "Неверный формат email",
    "auth/weak-password": "Слишком простой пароль",
    "auth/user-not-found": "Пользователь не найден",
    "auth/wrong-password": "Неверный пароль",
    "auth/invalid-credential": "Неверный email или пароль",
    "auth/too-many-requests": "Слишком много попыток, попробуйте позже"
  };
  return map[code];
}

async function handleLogout() { await signOut(auth); }

// ============================================================
// Ban check
// ============================================================
async function checkBanStatus(uid) {
  try {
    const snap = await getDoc(doc(db, "banned", uid));
    if (!snap.exists()) return null;
    const data = snap.data();
    if (data.until && data.until.seconds) {
      const untilMs = data.until.seconds * 1000;
      if (Date.now() > untilMs) {
        await deleteDoc(doc(db, "banned", uid));
        return null;
      }
    }
    return data;
  } catch (e) { return null; }
}

function showBanScreen(banData) {
  const screen = document.getElementById("banScreen");
  const text = document.getElementById("banText");
  const reasonBox = document.getElementById("banReasonBox");
  const reasonText = document.getElementById("banReasonText");
  const authContainer = document.getElementById("authContainer");
  const mainContainer = document.getElementById("mainContainer");
  const maintScreen = document.getElementById("maintenanceScreen");
  if (banData.until && banData.until.seconds) {
    const until = new Date(banData.until.seconds * 1000);
    text.textContent = "Доступ к сайту ограничен до " + until.toLocaleString("ru-RU");
  } else {
    text.textContent = "Доступ к сайту ограничен навсегда.";
  }
  if (banData.reason) {
    reasonText.textContent = banData.reason;
    reasonBox.classList.remove("hidden");
  } else {
    reasonBox.classList.add("hidden");
  }
  screen.classList.remove("hidden");
  if (authContainer) authContainer.classList.add("hidden");
  if (mainContainer) mainContainer.classList.add("hidden");
  if (maintScreen) maintScreen.classList.add("hidden");
}

function hideBanScreen() {
  const screen = document.getElementById("banScreen");
  if (screen) screen.classList.add("hidden");
}

// ============================================================
// Auth state
// ============================================================
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    const banData = await checkBanStatus(user.uid);
    if (banData) {
      await loadSiteSettingsOnce(user);
      applyMaintenanceState(user);
      showBanScreen(banData);
      return;
    } else {
      hideBanScreen();
    }
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    if (snap.exists()) userProfile = snap.data();
    else {
      const nick = user.email.split("@")[0];
      const profile = {
        nickname: nick, nicknameLower: nick.toLowerCase(),
        email: user.email, avatar: "🎵", achievements: [], xp: 0, scheme: "default",
        createdAt: serverTimestamp(), lastLogin: serverTimestamp(), loginDays: []
      };
      await setDoc(userRef, profile);
      userProfile = profile;
    }
    userAchievements = new Set(userProfile.achievements || []);
    loadLocalReported();
    loadMySubscriptions();     // не await — пусть грузится параллельно
    await registerLoginDay();
    await loadSiteSettingsOnce(user);
    subscribeSiteSettings(user);
    startMaintenancePolling(user);
    loadThemePreferenceFromLocal();
    const pref = userProfile.seasonThemePreference || "season";
    setThemePreference(pref);
    setUserScheme(userProfile.scheme || loadSchemeLocally());
    applySeasonTheme();
    await loadSeasonOnce();
    subscribeSeason();
    renderFinishedSeasonBanner();
    document.getElementById("authContainer").classList.add("hidden");
    document.getElementById("mainContainer").classList.remove("hidden");
    applyMaintenanceState(user);
    updateUserChip();
    showAdminNavIfNeeded();

    await Promise.all([
      loadMyRatings(),
      loadWishlist(user),
      loadNotifications(user)
    ]);

    // Прокидываем контекст в модули
    const myRatings = getMyRatings();
    setRatingsContext({
      currentUser,
      userProfile,
      callbacks: {
        onAddXp: addXp,
        onAfterSave: () => {
          loadMyRatings().then(() => {
            updateUserRatingCount();
            checkAchievements({ onAddXp: addXp });
          });
        },
        onAfterDelete: () => {
          loadMyRatings().then(() => {
            updateUserRatingCount();
            renderHistory();
          });
        }
      }
    });
    setBoardContext({
      currentUser,
      userProfile,
      callbacks: getFeedCallbacks()
    });
    setProfileContext({
      currentUser,
      userProfile,
      myRatings,
      userAchievements,
      callbacks: getProfileCallbacks()
    });
    setAdminContext({
      currentUser,
      userProfile,
      siteSettings: getSiteSettings(),
      callbacks: getAdminCallbacks()
    });
    setArtistsContext({
      currentUser,
      userProfile,
      callbacks: {
        onSwitchNav: (nav) => switchNav(nav),
        onLoadAlbum: (album) => loadAlbum(album),
        onCloseArtistPage: () => closeArtistPage(),
        onPushActivity: pushActivity,
        onAfterArtistRating: (artistId) => {
          if (artistId) openArtist(artistId);
        }
      }
    });
      setRecommendationsContext({
      currentUser,
      userProfile,
      callbacks: {
        onLoadAlbum: (album) => loadAlbum(album)
      }
    });
    loadRecommendations();
    setSearchContext({ currentUser });
    renderSearchHistory();
    renderFavorites();

    updateWishlistBadge();
    updateNotifDot();
    checkDraftBanner();
    updateUserRatingCount();
    updateUserLevelUI();
    subscribeFeed(getFeedCallbacks());
    renderHotToday(getFeedCallbacks());
  } else {
    userProfile = null;
    hideBanScreen();
    await loadSiteSettingsOnce(null);
    applyMaintenanceState(null);
    applyScheme("default");
    if (!getSiteSettings().maintenance) {
      document.getElementById("mainContainer").classList.add("hidden");
      document.getElementById("authContainer").classList.remove("hidden");
    }
  }
});

// ============================================================
// User / XP
// ============================================================
async function registerLoginDay() {
  if (!currentUser || !userProfile) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const days = userProfile.loginDays || [];
    if (!days.includes(today)) {
      days.push(today);
      if (days.length > 60) days.splice(0, days.length - 60);
      await updateDoc(doc(db, "users", currentUser.uid), { lastLogin: serverTimestamp(), loginDays: days });
      userProfile.loginDays = days;
      await addXp(XP_REWARDS.dailyLogin, "Ежедневный вход");
    }
  } catch (e) {}
}

function updateUserChip() {
  const nick = userProfile ? userProfile.nickname : "—";
  const isAdmin = currentUser && currentUser.uid === ADMIN_UID;
  let avatar = userProfile && userProfile.avatar ? userProfile.avatar : "🎵";
  if (isAdmin) {
    avatar = "💎";
    if (userProfile && userProfile.avatar !== "💎") {
      try { updateDoc(doc(db, "users", currentUser.uid), { avatar: "💎" }); } catch (e) {}
      userProfile.avatar = "💎";
    }
  } else {
    if (avatar === "👑" || avatar === "💎") avatar = "🎵";
  }
  document.getElementById("userNick").textContent = nick;
  document.getElementById("userAvatar").textContent = avatar;
  document.getElementById("userAvatar").style.background = colorFromString(nick);
  document.getElementById("userNick").classList.toggle("admin-nick", isAdmin);
}

function updateUserRatingCount() {
  const el = document.getElementById("userRatingCount");
  if (!el) return;
  const n = getMyRatings().length;
  el.textContent = "⭐ " + n;
}

function updateUserLevelUI() {
  if (!userProfile) return;
  const isAdmin = currentUser && currentUser.uid === ADMIN_UID;
  const badge = document.getElementById("userLevelBadge");
  if (!badge) return;
  if (isAdmin) {
    badge.innerHTML = '👑 <span class="lvl-num">ADM</span>';
    badge.title = "Администратор";
    badge.classList.add("admin-badge-chip");
  } else {
    const xp = userProfile.xp || 0;
    const lvl = getLevelByXp(xp);
    badge.innerHTML = lvl.emoji + ' <span class="lvl-num">' + lvl.level + '</span>';
    badge.title = lvl.emoji + " " + lvl.name + " · Уровень " + lvl.level;
    badge.classList.remove("admin-badge-chip");
  }
}

function showAdminNavIfNeeded() {
  const isAdmin = currentUser && currentUser.uid === ADMIN_UID;
  const adminTopBtn = document.getElementById("adminTopBtn");
  const suggestBtn = document.getElementById("suggestBtn");
  if (isAdmin) {
    if (adminTopBtn) adminTopBtn.classList.remove("hidden");
    if (suggestBtn) suggestBtn.classList.add("hidden");
  } else {
    if (adminTopBtn) adminTopBtn.classList.add("hidden");
    if (suggestBtn) suggestBtn.classList.remove("hidden");
  }
}

async function addXp(amount) {
  if (!currentUser || !userProfile || amount <= 0) return;
  if (currentUser.uid === ADMIN_UID) return;
  const oldXp = userProfile.xp || 0;
  const newXp = oldXp + amount;
  const oldLvl = getLevelByXp(oldXp);
  const newLvl = getLevelByXp(newXp);
  userProfile.xp = newXp;
  try { await updateDoc(doc(db, "users", currentUser.uid), { xp: newXp }); } catch (e) {}
  updateUserLevelUI();
  updateProfileLevelUI();
  if (newLvl.level > oldLvl.level) {
    showLevelUpToast(newLvl);
    if (newLvl.level >= 10) fireConfetti();
  }
}

function showLevelUpToast(lvl) {
  const container = document.getElementById("achievementToasts");
  const el = document.createElement("div");
  el.className = "levelup-toast";
  el.innerHTML = '<span class="ach-icon">' + lvl.emoji + '</span>' +
    '<div><div style="font-size:.72rem;opacity:.8;text-transform:uppercase;letter-spacing:.06em;">Новый уровень</div>' +
    '<div>Уровень ' + lvl.level + ' · ' + lvl.name + '</div></div>';
  container.appendChild(el);
  setTimeout(() => el.remove(), 4600);
}

function updateProfileLevelUI() {
  if (!userProfile) return;
  if (currentUser && currentUser.uid === ADMIN_UID) return;
  const xp = userProfile.xp || 0;
  const lvl = getLevelByXp(xp);
  const next = getNextLevel(xp);
  const iconEl = document.getElementById("levelIcon");
  if (!iconEl) return;
  iconEl.textContent = lvl.emoji;
  document.getElementById("levelNum").textContent = lvl.level;
  document.getElementById("levelName").textContent = lvl.name;
  document.getElementById("levelXp").textContent = xp + " XP";
  if (next) {
    const range = next.xp - lvl.xp;
    const passed = xp - lvl.xp;
    const pct = Math.min(100, Math.max(0, (passed / range) * 100));
    document.getElementById("xpFill").style.width = pct + "%";
    document.getElementById("xpToNext").textContent = "До следующего: " + (next.xp - xp) + " XP";
  } else {
    document.getElementById("xpFill").style.width = "100%";
    document.getElementById("xpToNext").textContent = "Максимальный уровень достигнут";
  }
  document.getElementById("xpTotal").textContent = "Всего: " + xp + " XP";
}

function fireConfetti() {
  const container = document.createElement("div");
  container.className = "confetti-container";
  document.body.appendChild(container);
  const colors = ["#f5c451","#e0a52c","#ff5577","#7c6cf0","#7ee0d4","#5ddc9a","#ffb84d"];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "%";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = (Math.random() * 0.8) + "s";
    piece.style.animationDuration = (2.5 + Math.random() * 1.5) + "s";
    container.appendChild(piece);
  }
  setTimeout(() => container.remove(), 4500);
}

// ============================================================
// Navigation
// ============================================================
function switchNav(nav) {
  const oldIdx = NAV_ORDER.indexOf(_lastNav);
  const newIdx = NAV_ORDER.indexOf(nav);
  const dir = newIdx > oldIdx ? "right" : (newIdx < oldIdx ? "left" : "fade");
  _lastNav = nav;
  currentNav = nav;
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.toggle("active", t.dataset.nav === nav));
  document.querySelectorAll(".mnav-btn").forEach(t => t.classList.toggle("active", t.dataset.nav === nav));
  const map = {
    main: "navMain", board: "navBoard", tops: "navTops",
    history: "navHistory", wishlist: "navWishlist",
    profile: "navProfile", admin: "navAdmin"
  };
  Object.keys(map).forEach(k => {
    const el = document.getElementById(map[k]);
    if (!el) return;
    const isTarget = k === nav;
    if (isTarget) {
      el.classList.remove("hidden");
      el.classList.remove("section-anim-right", "section-anim-left", "section-anim-fade");
      void el.offsetWidth;
      el.classList.add("section-anim-" + dir);
    } else {
      el.classList.add("hidden");
    }
  });
  if (nav === "board") refreshBoard();
  if (nav === "tops") {
    renderTops();
    switchRatingsTab("tops");
  }
  if (nav === "history") renderHistory();
  if (nav === "wishlist") renderWishlistScreen();
  if (nav === "profile") renderProfile();
  if (nav === "admin") renderAdmin();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goHome() { switchNav("main"); reset(); }

// ============================================================
// Activity feed push
// ============================================================
async function pushActivity(data) {
  try {
    await addDoc(collection(db, "activity"), {
      ...data,
      ts: serverTimestamp()
    });
  } catch (e) { console.warn("Не удалось записать activity:", e.message); }
}

// ============================================================
// Wishlist (обёртки для HTML)
// ============================================================
async function rateFromWishlist(source, id) {
  switchNav("main");
  await loadAlbum({ id, title: "", cover: "", source });
}
function openRandomWishlist() {
  const r = getRandomWishlistItem();
  if (!r) { showToast("Список пуст"); return; }
  rateFromWishlist(r.source, r.album.id);
}
function renderWishlistScreen() {
  renderWishlist(rateFromWishlist);
}

// ============================================================
// Suggest
// ============================================================
function openSuggest() {
  document.getElementById("suggestBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeSuggest() {
  document.getElementById("suggestBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}
async function submitSuggestion() {
  if (!currentUser) { showToast("Нужно войти"); return; }
  const title = document.getElementById("suggestTitle").value.trim();
  const artist = document.getElementById("suggestArtist").value.trim();
  const comment = document.getElementById("suggestComment").value.trim();
  const type = document.getElementById("suggestType").value;
  if (!title) { showToast("Введите название"); return; }
  try {
    await addDoc(collection(db, "suggestions"), {
      uid: currentUser.uid, nickname: userProfile.nickname,
      type, title, artist, comment, status: "pending", ts: serverTimestamp()
    });
    showToast("Заявка отправлена", { success: true });
    document.getElementById("suggestTitle").value = "";
    document.getElementById("suggestArtist").value = "";
    document.getElementById("suggestComment").value = "";
    closeSuggest();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ============================================================
// Share (заглушка)
// ============================================================
function openShareDialog() {
  if (!getCurrentAlbum()) { showToast("Сначала выберите релиз"); return; }
  showToast("📤 Шеринг-карточка скоро появится", { gold: true });
}

// ============================================================
// KEYDOWN
// ============================================================
document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === "Escape") {
    if (document.getElementById("modalBackdrop").classList.contains("open")) closeModal();
    if (document.getElementById("boardModalBackdrop").classList.contains("open")) closeBoardModal();
    if (document.getElementById("userProfileBackdrop").classList.contains("open")) closeUserProfile();
    if (document.getElementById("compareModalBackdrop").classList.contains("open")) closeCompareModal();
    if (document.getElementById("notifBackdrop").classList.contains("open")) closeNotifications();
    if (document.getElementById("suggestBackdrop").classList.contains("open")) closeSuggest();
    if (document.getElementById("editReleaseBackdrop").classList.contains("open")) closeEditRelease();
    if (document.getElementById("maintenanceBackdrop").classList.contains("open")) closeMaintenanceModal();
    if (document.getElementById("nowPlayingBackdrop").classList.contains("open")) closeNowPlayingPicker();
    if (document.getElementById("banModalBackdrop").classList.contains("open")) closeBanModal();
    if (document.getElementById("confirmBackdrop").classList.contains("open")) closeConfirm(false);
  } else if (e.key === "/") {
    e.preventDefault();
    const inp = document.getElementById("searchInput");
    if (inp) { switchNav("main"); setTimeout(() => inp.focus(), 100); }
  }
});

// ============================================================
// Click outside autocomplete
// ============================================================
document.addEventListener("mousedown", (e) => {
  const wrap = document.querySelector(".autocomplete-wrap");
  if (wrap && !wrap.contains(e.target)) closeSuggestions();
  const npWrap = document.querySelector("#nowPlayingModal .autocomplete-wrap");
  if (npWrap && !npWrap.contains(e.target)) {
    const npList = document.getElementById("nowPlayingSuggestions");
    if (npList) npList.classList.remove("open");
  }
});

// ============================================================
// Touch swipes
// ============================================================
document.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  swipeStartX = e.touches[0].clientX;
  swipeStartY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (e.changedTouches.length !== 1) return;
  const dx = e.changedTouches[0].clientX - swipeStartX;
  const dy = e.changedTouches[0].clientY - swipeStartY;
  const absDx = Math.abs(dx), absDy = Math.abs(dy);
  if (absDx < 100 || absDx < absDy * 1.5) return;
  if (dx > 0 && swipeStartX < 40) switchNav("board");
  if (dx < 0 && swipeStartX > window.innerWidth - 40) switchNav("main");
}, { passive: true });

// ============================================================
// Mobile nav autohide
// ============================================================
let _mobileNavLastScroll = 0;
let _mobileNavHidden = false;
function setupMobileNavAutoHide() {
  const nav = document.getElementById("mobileNav");
  if (!nav) return;
  window.addEventListener("scroll", () => {
    if (window.innerWidth > 700) return;
    const y = window.scrollY;
    if (y < 80) {
      nav.classList.remove("hidden-by-scroll");
      _mobileNavHidden = false;
      _mobileNavLastScroll = y;
      return;
    }
    const dy = y - _mobileNavLastScroll;
    if (Math.abs(dy) < 6) return;
    if (dy > 0 && !_mobileNavHidden && y > 200) {
      nav.classList.add("hidden-by-scroll");
      _mobileNavHidden = true;
    } else if (dy < 0 && _mobileNavHidden) {
      nav.classList.remove("hidden-by-scroll");
      _mobileNavHidden = false;
    }
    _mobileNavLastScroll = y;
  }, { passive: true });
}

// ============================================================
// Offline detection
// ============================================================
let _wasOffline = !navigator.onLine;
function setupOfflineDetection() {
  const banner = document.getElementById("offlineBanner");
  if (!banner) return;
  const update = () => {
    const offline = !navigator.onLine;
    if (offline) {
      banner.classList.remove("hidden");
      document.body.classList.add("has-offline-banner");
    } else {
      banner.classList.add("hidden");
      document.body.classList.remove("has-offline-banner");
      if (_wasOffline) showToast("Подключение восстановлено", { success: true });
    }
    _wasOffline = offline;
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

// ============================================================
// Callbacks для модулей
// ============================================================
function getFeedCallbacks() {
  return {
    onSwitchNav: (nav) => switchNav(nav),
    onLoadAlbum: (album) => loadAlbum(album),
    onOpenBoardModal: (group) => openBoardModal(group)
  };
}

function getAdminCallbacks() {
  return {
    onSwitchNav: (nav) => switchNav(nav),
    onOpenBoardModal: (group) => openBoardModal(group),
    onPushActivity: pushActivity,
    onReloadAlbum: () => {},
    onRenderMaintenance: renderAdminMaintenance,
    getCurrentAlbum: () => getCurrentAlbum(),
    getCurrentTracks: () => getCurrentTracks(),
    getCurrentSeason: () => getCurrentSeason(),
    getSeasonHistory: () => getSeasonHistory(),
    computeSeasonAwards: (season) => computeSeasonAwards(season),
    onSeasonChanged: () => {
      // Перечитать сезон из Firestore и перерисовать всё
      loadSeasonOnce().then(() => {
        applySeasonTheme();
        renderSeasonBanner();
      });
    },
    onAfterDeleteRelease: () => {
      loadMyRatings().then(() => {
        updateUserRatingCount();
        renderHistory();
      });
    },
    onAdminTabChange: () => {}
  };
}

function getProfileCallbacks() {
  return {
    onUpdateUserChip: updateUserChip,
    onUpdateLevelUI: updateProfileLevelUI,
    onAddXp: addXp,
    getCurrentSeason: () => getCurrentSeason(),
    getSeasonHistory: () => getSeasonHistory(),
    getThemePreference: () => getThemePreference(),
    setThemePreference: (pref) => setThemePreference(pref),
    isParticlesOff: () => isParticlesOff(),
    setParticlesOff: (off) => setParticlesOff(off),
    applySeasonTheme: () => applySeasonTheme(),
    onSwitchNav: (nav) => switchNav(nav),
    onOpenBoardModal: (group) => openBoardModal(group),
    onGetBoardData: () => getBoardData(),
    onOpenArtist: (artistId) => openArtist(artistId),
    onOpenRelease: (src, rid) => {
      const group = getBoardData().find(b => b.source === src && b.releaseId === String(rid));
      if (group) { switchNav("board"); setTimeout(() => openBoardModal(group), 250); }
      else { switchNav("main"); loadAlbum({ id: rid, title: "", cover: "", source: src }); }
    }
  };
}

// ============================================================
// WINDOW EXPORTS
// ============================================================
window.handleAuthSubmit = handleAuthSubmit;
window.toggleAuthMode = toggleAuthMode;
window.handleLogout = handleLogout;
window.cycleTheme = cycleTheme;
window.switchNav = switchNav;
window.goHome = goHome;

window.setRatingMode = setRatingMode;
window.onSearchInput = () => {
  const inp = document.getElementById("searchInput");
  const q = inp ? inp.value.trim() : "";
  setRecommendationsVisible(q.length < 2);
  onSearchInput(
    (album) => loadAlbum(album),
    (artistId) => openArtist(artistId)
  );
};
window.onSearchKeydown = (e) => onSearchKeydown(
  e,
  (album) => loadAlbum(album),
  (artistId) => openArtist(artistId)
);
window.checkShowSuggestions = () => { try { showSuggestions(); } catch (e) {} };

window.openBoardModal = (g) => openBoardModal(g);
window.closeBoardModal = closeBoardModal;
window.openCalculatorFromBoard = () => {
  const g = getBoardModalRelease();
  if (!g) return;
  closeBoardModal();
  switchNav("main");
  loadAlbum({ id: g.album.id || g.releaseId, title: g.album.title, cover: g.album.artwork, source: g.source });
};
window.refreshBoard = refreshBoard;
window.onBoardSearchInput = onBoardSearchInput;
window.renderHistory = renderHistory;
window.switchTopTab = switchTopTab;
window.switchAdminTab = switchAdminTab;

window.clearReviewInput = clearReviewInput;

window.openArtist = openArtist;
window.closeArtistPage = closeArtistPage;
window.openAlbumFromArtist = openAlbumFromArtist;
window.openArtistRatingForm = openArtistRatingForm;

window.openBanModal = openBanModal;
window.closeBanModal = closeBanModal;
window.selectBanDuration = selectBanDuration;
window.confirmBanUser = confirmBanUser;
window.unbanUser = unbanUser;
window.resetUserProgress = resetUserProgress;
window.approveSuggestion = approveSuggestion;
window.rejectSuggestion = rejectSuggestion;
window.deleteSuggestion = deleteSuggestion;
window.createRelease = createRelease;
window.adminOpenStartSeasonModal = adminOpenStartSeasonModal;
window.adminCloseStartSeasonModal = adminCloseStartSeasonModal;
window.adminSelectSeasonType = adminSelectSeasonType;
window.adminUpdateSeasonYear = adminUpdateSeasonYear;
window.adminConfirmStartSeason = adminConfirmStartSeason;
window.adminFinishSeason = adminFinishSeason;
window.adminDeleteSeasonFromHistory = adminDeleteSeasonFromHistory;

window.clearSearchHistory = clearSearchHistory;
window.toggleFavoritesCollapse = toggleFavoritesCollapse;
window.addToFavorites = addToFavorites;

window.toggleArtistFavorite = toggleArtistFavorite;

window.openArtistRatingForm = openArtistRatingForm;
window.closeArtistRatingForm = closeArtistRatingForm;
window.applyArtistRating = applyArtistRating;
window.toggleArtistHelp = toggleArtistHelp;

window.openArtistFromBoard = (artistId) => {
  switchNav("main");
  setTimeout(() => openArtist(artistId), 250);
};

window.openArtistByName = async (name) => {
  try {
    const items = await searchArtists(name, 1);
    if (items && items[0]) {
      const id = items[0].id;
      switchNav("main");
      setTimeout(() => openArtist(id), 250);
    } else {
      showToast("Артист не найден");
    }
  } catch (e) {
    showToast("Не удалось открыть артиста");
  }
};

window.closeModal = closeModal;
window.toggleHelp = toggleHelp;
window.toggleHelpSingle = toggleHelpSingle;
window.applyModalRating = applyModalRating;
window.rateTrackAsSingle = () => rateTrackAsSingle((album) => {
  switchNav("main");
  loadAlbum({ id: album.id, title: album.title, cover: album.artwork, source: album.source });
});
window.submitRating = () => submitRating();
window.reset = () => {
  reset();
  setRecommendationsVisible(true);
};
window.toggleHistogram = toggleHistogram;
window.onCoverRatingChange = onCoverRatingChange;

window.addToWishlist = () => addToWishlist(currentUser, getCurrentAlbum());
window.rateFromWishlist = rateFromWishlist;
window.removeFromWishlist = (id) => removeFromWishlist(id, () => renderWishlistScreen());
window.openRandomWishlist = openRandomWishlist;

window.openCompareSelector = openCompareSelector;
window.compareGo = () => compareGo({ onAddXp: addXp });
window.compareBack = compareBack;
window.closeCompareModal = closeCompareModal;

window.refreshRecommendations = refreshRecommendations;
window.refreshRandomReco = refreshRandomReco;

window.openNotifications = openNotifications;
window.closeNotifications = closeNotifications;
window.continueDraft = () => continueDraft((album) => loadAlbum(album));
window.dismissDraft = dismissDraft;
window.openProfile = () => switchNav("profile");
window.saveNickname = saveNickname;
window.switchProfileTab = switchProfileTab;

window.adminEditRelease = adminEditRelease;
window.closeEditRelease = closeEditRelease;
window.saveEditRelease = saveEditRelease;
window.resetEditRelease = resetEditRelease;
window.adminDeleteReleaseFromBoard = adminDeleteReleaseFromBoard;

window.openSuggest = openSuggest;
window.closeSuggest = closeSuggest;
window.submitSuggestion = submitSuggestion;

window.adminRecountAwards = adminRecountAwards;

window.showConfirm = showConfirm;
window.closeConfirm = closeConfirm;

window.openMaintenanceModal = () => openMaintenanceModal(currentUser);
window.closeMaintenanceModal = closeMaintenanceModal;
window.saveMaintenanceSettings = () => saveMaintenanceSettings(currentUser);
window.toggleMaintenance = () => toggleMaintenance(currentUser);
window.dismissAnnouncement = dismissAnnouncement;
window.publishAnnouncement = publishAnnouncement;
window.deleteAnnouncement = deleteAnnouncement;

window.refreshFeed = () => refreshFeed(getFeedCallbacks());
window.switchFeedTab = (tab) => {
  // ленивая подгрузка подписок при первом входе в «Подписки»
  if (tab === "subs") {
    loadMySubscriptions().then(() => {
      document.querySelectorAll(".feed-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.feed === tab);
      });
      renderFeed(getFeedCallbacks());
    });
  } else {
    document.querySelectorAll(".feed-tab").forEach(t => {
      t.classList.toggle("active", t.dataset.feed === tab);
    });
    renderFeed(getFeedCallbacks());
  }
};
window.subscribeToUser = subscribeToUser;
window.unsubscribeFromUser = unsubscribeFromUser;
window.openUserProfile = (uid) => openUserProfile(uid, {
  onOpenRelease: (src, rid) => {
    const group = getBoardData().find(b => b.source === src && b.releaseId === String(rid));
    if (group) { switchNav("board"); setTimeout(() => openBoardModal(group), 250); }
    else { switchNav("main"); loadAlbum({ id: rid, title: "", cover: "", source: src }); }
  }
});
window.closeUserProfile = closeUserProfile;
window.openCompareWithUser = (uid) => openCompareWithUser(uid);

window.openNowPlayingPicker = openNowPlayingPicker;
window.closeNowPlayingPicker = closeNowPlayingPicker;
window.onNowPlayingSearchInput = onNowPlayingSearchInput;
window.onNowPlayingKeydown = onNowPlayingKeydown;
window.clearNowPlaying = clearNowPlaying;

window.openShareDialog = openShareDialog;
window.adminJumpToComment = adminJumpToComment;
window.adminDeleteReportedReview = adminDeleteReportedReview;
window.clearReviewReports = clearReviewReports;
window.adminDeleteReviewManually = adminDeleteReviewManually;

window.openArtistFromBoard = (artistId) => {
  switchNav("main");
  setTimeout(() => openArtist(artistId), 250);
};

window.openArtistByName = async (name) => {
  try {
    const items = await searchArtists(name, 1);
    if (items && items[0]) {
      const id = items[0].id;
      switchNav("main");
      setTimeout(() => openArtist(id), 250);
    }
  } catch (e) { showToast("Артист не найден"); }
};

// ============================================================
// INIT
// ============================================================
initTheme();
initRatingMode();
setupMobileNavAutoHide();
setupOfflineDetection();
loadLocalReported();

setRatingsContext({
  currentUser,
  userProfile,
  callbacks: {
    onAddXp: addXp,
    onAfterSave: () => { loadMyRatings().then(() => { updateUserRatingCount(); checkAchievements({ onAddXp: addXp }); }); },
    onAfterDelete: () => { loadMyRatings().then(() => { updateUserRatingCount(); renderHistory(); }); }
  }
});
setBoardContext({ currentUser, userProfile, callbacks: getFeedCallbacks() });
setProfileContext({
  currentUser, userProfile,
  myRatings: getMyRatings(),
  userAchievements,
  callbacks: getProfileCallbacks()
});
setAdminContext({
  currentUser, userProfile,
  siteSettings: getSiteSettings(),
  callbacks: getAdminCallbacks()
});
setArtistsContext({
  currentUser,
  userProfile,
  callbacks: {
    onSwitchNav: (nav) => switchNav(nav),
    onLoadAlbum: (album) => loadAlbum(album),
    onCloseArtistPage: () => closeArtistPage(),
    onPushActivity: pushActivity,
    onAfterArtistRating: (artistId) => {
      // Перерисовываем страницу артиста
      if (artistId) openArtist(artistId);
    }
  }
});
setSeasonContext({
  callbacks: {
    onSeasonChanged: () => {
      applySeasonTheme();
      renderSeasonBanner();
      renderFinishedSeasonBanner();
      // Если вкладка «Рейтинги» открыта — обновляем архив сезонов
      if (!document.getElementById("navTops").classList.contains("hidden")) {
        renderSeasonsArchive();
      }
    }
  }
});

loadThemePreferenceFromLocal();

// Debug
window._db = db;
window._auth = auth;
window._adminUid = ADMIN_UID;