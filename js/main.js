import {
  app, auth, db,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged,
  collection, doc, setDoc, getDoc, getDocs,
  query, where, deleteDoc, serverTimestamp, addDoc, updateDoc,
  onSnapshot, orderBy, fbLimit
} from './firebase.js';

import {
  firebaseConfig, ADMIN_UID, ITUNES_PROXY,
  FINAL_MAX, MAX_TRACKS, DEBOUNCE_MS,
  SEARCH_CACHE_TTL, RELEASE_CACHE_TTL, MAINTENANCE_DEFAULT_MSG, NOW_PLAYING_TTL,
  RATE_LIMIT_MS, RATE_LIMIT_HOUR, BOARD_PAGE_SIZE, FEED_PAGE_SIZE, FEED_MAX_ITEMS,
  SCHEME_KEY, REPORT_THRESHOLD,
  LS_THEME, LS_MODE, LS_SOURCE, LS_DRAFT,
  LS_SEARCH_CACHE, LS_RELEASE_CACHE, LS_RATING_TIMES, LS_ANNOUNCEMENT, LS_REPORTS,
  TIERS, LEVELS, XP_REWARDS,
  VERDICTS_ALBUM, VERDICTS_SINGLE, VERDICTS_TRACK,
  TRACK_CRITERIA, VIBE_KEY, MAIN_CRITERIA,
  EMOJI_AVATARS, SCHEMES, ACHIEVEMENTS
} from './config.js';

import {
  getLevelByXp, getNextLevel,
  computeFinalScore, computeSingleScore,
  getTier, getNextTier,
  plural, escapeHtml, colorFromString,
  tierMedalHtml, tierBadgeHtml,
  formatTime
} from './utils.js';

import {
  showToast, showFloatingLoader,
  showWarning, hideWarning,
  renderSkeletonList, renderSkeletonCards
} from './ui.js';

import { showConfirm, closeConfirm } from './confirm.js';

import {
  applyScheme, saveSchemeLocally, loadSchemeLocally,
  initTheme, applyTheme, cycleTheme
} from './theme.js';

import {
  loadNotifications, updateNotifDot,
  openNotifications, closeNotifications, notifyUser
} from './notifications.js';

import {
  cacheGet, cacheSet,
  cacheCover, getCachedCoverBlob,
  scheduleCoverCaching, hydrateImagesFromCache
} from './cache.js';

import {
  loadWishlist, updateWishlistBadge,
  addToWishlist, removeFromWishlistIfExists,
  renderWishlist, getRandomWishlistItem
} from './wishlist.js';

import {
  getSiteSettings, loadSiteSettingsOnce, subscribeSiteSettings,
  startMaintenancePolling, applyMaintenanceState, applyAnnouncementState,
  dismissAnnouncement, openMaintenanceModal, closeMaintenanceModal,
  saveMaintenanceSettings, toggleMaintenance, renderAdminMaintenance
} from './site-settings.js';

import {
  jsonp, spotifyFetch, spotifySearchAlbums, spotifyGetAlbum, mapSpotifyAlbum,
  onSearchInput, onSearchKeydown, chooseSuggestion,
  showSuggestions, closeSuggestions, updateActiveHighlight,
  resetSearchState
} from './search.js';

import {
  setRatingsContext, getCurrentAlbum, getCurrentTracks, getMyRatings, getTrackDetails,
  loadAlbum, applyOverride, prefillUserRatingIfExists,
  renderAlbum, setRatingMode, initRatingMode,
  onCoverRatingChange, updateScore, toggleHistogram,
  openModal, closeModal, toggleHelp, toggleHelpSingle,
  rateTrackAsSingle, applyModalRating,
  submitRating, deleteMyRating, loadMyRatings, renderHistory, restoreFromMyRatings,
  saveDraft, clearDraft, checkDraftBanner, continueDraft, dismissDraft,
  reset
} from './ratings.js';

import {
  setBoardContext, getBoardData, getBoardModalRelease, getMyReportedComments,
  loadLocalReported, saveLocalReported,
  refreshBoard, renderBoard, renderBoardDynamicStats, onBoardSearchInput,
  openBoardModal, closeBoardModal,
  loadComments, submitComment, reportComment, replyToComment,
  switchTopTab, renderTops,
  subscribeFeed, refreshFeed, renderFeed, renderHotToday
} from './board.js';

import {
  setProfileContext, getUserAchievements,
  renderProfile, getFavoriteArtist, saveNickname,
  renderNowPlayingSection, openNowPlayingPicker, closeNowPlayingPicker,
  onNowPlayingSearchInput, onNowPlayingKeydown, clearNowPlaying,
  renderAchievements, checkAchievements,
  openCompareSelector, compareGo, compareBack, closeCompareModal,
  openUserProfile, closeUserProfile, openCompareWithUser
} from './profile.js';


// ---------- ГЛОБАЛЬНОЕ СОСТОЯНИЕ ----------
let currentUser = null;
let userProfile = null;
let currentAlbum = null;
let currentTracks = [];
let ratingMode = "slider";
let overallValue = 7;
let coverRating = 7;
let currentSource = "itunes";
let lastFinalScore = null;
let trackDetails = {};
let singleValues = {};
let lastSuggestions = [];
let activeIndex = -1;
let debounceTimer = null;
let modalTrackIndex = -1;
let modalValues = {};
let boardData = [];
let boardModalRelease = null;
let myRatings = [];
let wishlistItems = [];
let notifications = [];
let compareSelection = [];
let currentTopTab = "all";
let currentAdminTab = "dashboard";
let boardSearchQuery = "";
let currentNav = "main";
let userAchievements = new Set();
let sessionStart = Date.now();
let ratingsThisSession = 0;
let lastDeletedRating = null;
let lastDeletedRatingTimeout = null;
let swipeStartX = 0;
let swipeStartY = 0;
let siteSettings = { maintenance: false, maintenanceMessage: "" };
let _maintenanceUnsub = null;
let _maintenancePollTimer = null;
let _settingsUnsub = null;
let myReportedComments = new Set();
let currentFeedTab = "all";
let feedItems = [];
let feedData = [];
let feedRendered = 0;
let feedAllLoaded = false;
let feedLoading = false;
let _feedObserver = null;
let _feedUnsub = null;
let nowPlayingSuggestions = [];
let nowPlayingActiveIndex = -1;
let nowPlayingDebounce = null;
let _userProfileViewUid = null;
let boardPageSize = BOARD_PAGE_SIZE;
let boardRendered = 0;
let boardFilteredList = [];
let boardLoadingMore = false;
let boardAllLoaded = false;
let boardSearchLower = "";
let _banCheckUnsub = null;
let _banTargetUid = null;
let _banSelectedDays = 7;
let _pendingDeleteContext = null;


function loadLocalReported() {
  try {
    const raw = localStorage.getItem(LS_REPORTS);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) myReportedComments = new Set(arr);
  } catch (e) {}
}
function saveLocalReported() {
  try {
    localStorage.setItem(LS_REPORTS, JSON.stringify(Array.from(myReportedComments)));
  } catch (e) {}
}



// ---------- OFFLINE DETECTION ----------
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
      if (_wasOffline) {
        showToast("Подключение восстановлено", { success: true });
      }
    }
    _wasOffline = offline;
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}







// ---------- RATE LIMIT ----------
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


// ---------- АВТОРИЗАЦИЯ ----------
let authMode = "login";
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

// ---------- BAN CHECK ----------
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

// ---------- AUTH STATE ----------
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    // Проверка бана
    const banData = await checkBanStatus(user.uid);
    if (banData) {
      await loadSiteSettingsOnce();
      applyMaintenanceState();
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
    await registerLoginDay();
    await loadSiteSettingsOnce();
    subscribeSiteSettings();
    startMaintenancePolling();
    // применяем цветовую схему
    applyScheme(userProfile.scheme || loadSchemeLocally());
    document.getElementById("authContainer").classList.add("hidden");
    document.getElementById("mainContainer").classList.remove("hidden");
    applyMaintenanceState();
    updateUserChip();
    showAdminNavIfNeeded();
    await Promise.all([loadMyRatings(), loadWishlist(), loadNotifications()]);
    updateWishlistBadge();
    updateNotifDot();
    checkDraftBanner();
    updateUserRatingCount();
    updateUserLevelUI();
    // лента
    subscribeFeed();
    renderHotToday();
    // стартовые рекомендации
    showAiRecommendation();
  } else {
    userProfile = null;
    hideBanScreen();
    await loadSiteSettingsOnce();
    applyMaintenanceState();
    applyScheme("default");
    if (!siteSettings.maintenance) {
      document.getElementById("mainContainer").classList.add("hidden");
      document.getElementById("authContainer").classList.remove("hidden");
    }
  }
});

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
    // Админ — всегда 💎
    avatar = "💎";
    if (userProfile && userProfile.avatar !== "💎") {
      // Синхронизируем в Firestore, чтобы нигде не осталась старая
      try { updateDoc(doc(db, "users", currentUser.uid), { avatar: "💎" }); } catch (e) {}
      userProfile.avatar = "💎";
    }
  } else {
    // У обычного юзера не может быть короны или алмаза
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
  const n = myRatings.length;
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
    suggestBtn.classList.add("hidden");
  } else {
    if (adminTopBtn) adminTopBtn.classList.add("hidden");
    suggestBtn.classList.remove("hidden");
  }
}
async function addXp(amount, reason) {
  if (!currentUser || !userProfile || amount <= 0) return;
  // У админа нет уровней и XP
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
  // У админа нет уровня — выходим
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

// ---------- NAVIGATION ----------
let _lastNav = "main";
const NAV_ORDER = ["main", "board", "tops", "history", "wishlist", "profile", "admin"];
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
  if (nav === "tops") renderTops();
  if (nav === "history") renderHistory();
  if (nav === "wishlist") renderWishlist();
  if (nav === "profile") renderProfile();
  if (nav === "admin") renderAdmin();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function goHome() { switchNav("main"); reset(); }

// ---------- ИСТОЧНИКИ ----------
function initSource() {
  currentSource = "spotify";
  applySourceUI();
}

function setSource(src) {
  currentSource = "spotify";
  applySourceUI();
}
function applySourceUI() {
  document.querySelectorAll(".source-tab").forEach(b => b.classList.toggle("active", b.dataset.src === currentSource));
}





// ---------- УДАЛЕНИЕ ОЦЕНКИ ----------
async function deleteMyRating(source, releaseId, onDone) {
  if (!currentUser) return;
  const ok = await showConfirm({
    icon: "🗑",
    title: "Удалить оценку?",
    text: "Релиз и все его треки исчезнут из истории. Действие можно отменить сразу после удаления.",
    okText: "Удалить",
    okClass: "btn-danger"
  });
  if (!ok) return;
  const docId = source + "_" + releaseId + "_" + currentUser.uid;
  try {
    const snap = await getDoc(doc(db, "ratings", docId));
    if (!snap.exists()) return;
    const backupData = snap.data();
    await deleteDoc(doc(db, "ratings", docId));
    if (lastDeletedRatingTimeout) clearTimeout(lastDeletedRatingTimeout);
    lastDeletedRating = { docId, backupData };
    showToast("Оценка удалена", {
      undo: async () => {
        try {
          await setDoc(doc(db, "ratings", docId), backupData);
          showToast("Оценка восстановлена", { success: true });
          lastDeletedRating = null;
          if (onDone) onDone();
        } catch (e) { showToast("Ошибка: " + e.message); }
      },
      duration: 5000
    });
    lastDeletedRatingTimeout = setTimeout(() => { lastDeletedRating = null; lastDeletedRatingTimeout = null; }, 5200);
    if (onDone) onDone();
    await loadMyRatings();
    updateUserRatingCount();
  } catch (e) { showToast("Ошибка удаления: " + e.message); }
}

// ---------- ИСТОРИЯ ОЦЕНОК ----------
async function loadMyRatings() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "ratings"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    myRatings = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    myRatings.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
  } catch (e) { myRatings = []; }
}
function renderHistory() {
  const list = [...myRatings];
  const sort = document.getElementById("historySort").value;
  const listEl = document.getElementById("historyList");
  const statsEl = document.getElementById("artistStats");
  list.sort((a, b) => {
    switch (sort) {
      case "date_desc": return (b.ts?.seconds || 0) - (a.ts?.seconds || 0);
      case "date_asc":  return (a.ts?.seconds || 0) - (b.ts?.seconds || 0);
      case "score_desc":return b.final - a.final;
      case "score_asc": return a.final - b.final;
      case "title_asc": return (a.album.title || "").localeCompare(b.album.title || "");
      case "artist_asc":return (a.album.artist || "").localeCompare(b.album.artist || "");
      default: return 0;
    }
  });
  const byArtist = {};
  list.forEach(x => {
    const a = x.album.artist || "Unknown";
    if (!byArtist[a]) byArtist[a] = [];
    byArtist[a].push(x.final);
  });
  const multiple = Object.entries(byArtist).filter(([, arr]) => arr.length >= 2)
    .map(([artist, arr]) => {
      const avg = Math.round(arr.reduce((x, y) => x + y, 0) / arr.length);
      return { artist, avg, count: arr.length, tier: getTier(avg) };
    }).sort((a, b) => b.avg - a.avg);
  statsEl.innerHTML = multiple.length
    ? multiple.slice(0, 3).map(s => s.tier.emoji + ' <b>' + escapeHtml(s.artist) + '</b> — средняя ' + s.avg + ' (' + s.count + ' ' + plural(s.count, "релиз", "релиза", "релизов") + ')').join("<br>")
    : "";
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty-msg">Здесь пока пусто.<br>Оцените релиз и нажмите «Поставить оценку».</div>';
    renderPearls(); return;
  }
  listEl.innerHTML = "";
  list.forEach(item => {
    const tier = getTier(item.final);
    const el = document.createElement("div");
    el.className = "history-item " + tier.cssClass;
    el.innerHTML = '<img src="' + escapeHtml(item.album.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="info"><div class="title">' + escapeHtml(item.album.title) + '</div><div class="artist">' + escapeHtml(item.album.artist) + '</div></div>' +
      '<span class="tier-tag">' + tier.emoji + ' ' + tier.name + '</span>' +
      '<div class="score">' + item.final + '</div>' +
      '<button class="del" title="Удалить оценку">×</button>';
    el.onclick = (ev) => { if (ev.target.classList.contains("del")) return; restoreFromMyRatings(item); };
    el.querySelector(".del").onclick = async (ev) => {
      ev.stopPropagation();
      await deleteMyRating(item.source, item.releaseId, () => { loadMyRatings().then(renderHistory); });
    };
    listEl.appendChild(el);
  });
  listEl.querySelectorAll("img").forEach(img => { img.dataset.cacheable = "1"; img.dataset.src = img.src; });
  scheduleCoverCaching(list.map(it => it.album.artwork).filter(Boolean));
  hydrateImagesFromCache(listEl);
  renderPearls();
}
function renderPearls() {
  const pearls = myRatings.filter(r => {
    const tier = getTier(r.final);
    return tier.name === "Алмаз" || tier.name === "Бриллиант";
  });
  const section = document.getElementById("pearlsSection");
  const listEl = document.getElementById("pearlsList");
  if (pearls.length === 0) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");
  listEl.innerHTML = "";
  pearls.forEach(item => {
    const tier = getTier(item.final);
    const el = document.createElement("div");
    el.className = "history-item " + tier.cssClass;
    el.innerHTML = '<img src="' + escapeHtml(item.album.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="info"><div class="title">' + escapeHtml(item.album.title) + '</div><div class="artist">' + escapeHtml(item.album.artist) + '</div></div>' +
      '<span class="tier-tag">' + tier.emoji + ' ' + tier.name + '</span>' +
      '<div class="score">' + item.final + '</div>';
    el.onclick = () => restoreFromMyRatings(item);
    listEl.appendChild(el);
  });
}
async function restoreFromMyRatings(item) {
  switchNav("main");
  currentAlbum = { id: item.album.id, title: item.album.title, artist: item.album.artist, artwork: item.album.artwork, source: item.album.source || item.source };
  currentTracks = (item.scores || []).map((v, i) => ({ name: "Трек " + (i + 1), artist: currentAlbum.artist }));
  try {
    if (currentAlbum.source === "spotify") {
      const data = await spotifyGetAlbum(currentAlbum.id);
      if (data && data.tracks && data.tracks.items) {
        currentTracks = data.tracks.items
          .sort((a, b) => (a.track_number || 0) - (b.track_number || 0))
          .map(t => ({ name: t.name, artist: (t.artists || []).map(x => x.name).join(", ") || currentAlbum.artist, isSkit: false }));
      }
    }
  } catch (e) {}
  overallValue = item.overall || 7;
  coverRating = item.coverRating || 7;
  trackDetails = item.details || {};
  currentAlbum._prefillScores = item.scores || null;
  // Восстанавливаем скиты
  if (item.skitIndexes && Array.isArray(item.skitIndexes)) {
    item.skitIndexes.forEach(i => {
      if (currentTracks[i]) currentTracks[i].isSkit = true;
    });
  }
  singleValues = {};
  if (currentTracks.length === 1 && item.details && item.details[0]) singleValues = { ...item.details[0] };
  document.getElementById("step1").classList.add("hidden");
  document.getElementById("step2").classList.remove("hidden");
  renderAlbum();
  showToast("Загружено из ваших оценок");
}

async function pushActivity(data) {
  try {
    await addDoc(collection(db, "activity"), {
      ...data,
      ts: serverTimestamp()
    });
  } catch (e) { console.warn("Не удалось записать activity:", e.message); }
}

// ---------- REPLY MENTION ----------
function replyToComment(nickname) {
  const input = document.getElementById("commentInput");
  if (!input) return;
  input.value = "@" + nickname + ", " + input.value.replace(/^@[^,]+, /, "");
  input.focus();
  // Прокрутить к полю
  input.scrollIntoView({ behavior: "smooth", block: "center" });
}




// ---------- МОДАЛКА РЕЛИЗА НА ДОСКЕ ----------
async function openBoardModal(group) {
  boardModalRelease = group;
  document.getElementById("boardModalCover").src = group.album.artwork || "";
  document.getElementById("boardModalCover").onerror = function() { this.style.visibility = "hidden"; };
  document.getElementById("boardModalTitle").textContent = group.album.title;
  document.getElementById("boardModalArtist").textContent = group.album.artist;
  document.getElementById("boardModalAvg").textContent = group.avgFinal;
  document.getElementById("boardModalAvgHint").textContent = "из " + FINAL_MAX + " · " + group.userCount + " " + plural(group.userCount, "оценка", "оценки", "оценок");
  const hasAdmin = group.adminRating != null;
  document.getElementById("boardModalAdmin").textContent = hasAdmin ? group.adminRating : "—";
  document.getElementById("boardModalAdminHint").textContent = hasAdmin ? "из " + FINAL_MAX : "ещё не оценил";
  if (currentUser && currentUser.uid === ADMIN_UID) document.getElementById("adminBoardQuick").classList.remove("hidden");
  else document.getElementById("adminBoardQuick").classList.add("hidden");
  renderBoardModalUsers(group);
  await loadComments(group.source, group.releaseId);
  document.getElementById("boardModalBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}
function renderBoardModalUsers(group) {
  const usersEl = document.getElementById("boardModalUsers");
  usersEl.innerHTML = "";
  const sorted = [...group.ratings].sort((a, b) => b.final - a.final);
  sorted.forEach(r => {
    const isAdmin = r.uid === ADMIN_UID;
    const isMe = currentUser && r.uid === currentUser.uid;
    const avatar = r.avatar || "🎵";
    const lvlNum = isAdmin ? "👑" : (r.level || 1);
    const row = document.createElement("div");
    row.className = "board-modal-user-row";
    const adminStyle = isAdmin ? 'background:linear-gradient(135deg,var(--gold-1),var(--gold-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:700;' : '';
    let changeBadge = "";
    if (r.history && r.history.length > 0) {
      const last = r.history[r.history.length - 1];
      changeBadge = '<span style="font-size:.72rem; color:var(--text-dim); margin-right:6px;" title="Оценка изменена">' +
        '<span style="text-decoration:line-through; opacity:.6;">' + last.oldFinal + '</span> →</span>';
    }
    row.innerHTML = '<div class="avatar-sm clickable-avatar" style="background:' + colorFromString(r.nickname || "?") + '" data-uid="' + r.uid + '" title="Открыть профиль">' + escapeHtml(avatar) + '<span class="mini-level' + (isAdmin ? ' admin-mini' : '') + '">' + lvlNum + '</span></div>' +
      '<div class="name"><span class="clickable-name" style="' + adminStyle + '" data-uid="' + r.uid + '" title="Открыть профиль">' + escapeHtml(r.nickname || "Без имени") + (isAdmin ? ' <span style="color:var(--gold-lvl);">👑</span>' : "") + (isMe ? ' <span style="color:var(--accent-3);font-size:.75rem;">(вы)</span>' : "") + '</span></div>' +
      changeBadge +
      '<div class="num">' + r.final + '</div>' +
      (isMe ? '<button class="del-sm" title="Удалить мою оценку">×</button>' : "");
    row.onclick = (ev) => {
      // Кнопка удаления — отдельная логика
      if (ev.target.classList.contains("del-sm")) return;

      // Клик по нику или аватарке → профиль пользователя
      if (ev.target.closest(".clickable-name") || ev.target.closest(".clickable-avatar")) {
        ev.stopPropagation();
        openUserProfile(r.uid);
        return;
      }

      // Клик по любому другому месту строки → развернуть подробную оценку
      showUserRatingInline(group, r.uid, row);
    };
    const delBtn = row.querySelector(".del-sm");
    if (delBtn) {
      delBtn.onclick = async (ev) => {
        ev.stopPropagation();
        await deleteMyRating(group.source, group.releaseId, () => { closeBoardModal(); loadMyRatings().then(() => refreshBoard()); });
      };
    }
    usersEl.appendChild(row);
  });
}
async function showUserRatingInline(group, uid, rowEl) {
  const existing = rowEl.nextElementSibling;
  if (existing && existing.classList.contains("board-user-detail")) { existing.remove(); return; }
  document.querySelectorAll(".board-user-detail").forEach(el => el.remove());
  try {
    const docId = group.source + "_" + group.releaseId + "_" + uid;
    const snap = await getDoc(doc(db, "ratings", docId));
    if (!snap.exists()) return;
    const data = snap.data();
    const detail = document.createElement("div");
    detail.className = "board-user-detail";
    let html = '<div style="font-weight:700;color:var(--text);margin-bottom:8px;">Подробная оценка</div>';
    html += '<div style="display:flex; flex-wrap:wrap; gap:10px; font-size:.82rem; margin-bottom:10px;">';
    html += '<span>Средняя треков: <b>' + (data.avg || 0).toFixed(2) + '</b> / 10</span>';
    html += '<span>Вайб: <b>' + (data.overall || "—") + '</b> / 10</span>';
    if (data.coverRating) html += '<span>🎨 Обложка: <b>' + data.coverRating + '</b> / 10</span>';
    html += '<span>Итог: <b>' + data.final + '</b> / 360</span>';
    html += '</div>';
    if (data.history && data.history.length > 0) {
      html += '<div style="margin:10px 0; padding:8px 12px; background:rgba(0,0,0,.15); border-radius:8px; font-size:.78rem;">';
      html += '<b style="color:var(--text);">История:</b> ';
      html += data.history.slice(-3).map(h => {
        const d = h.ts ? new Date(h.ts * 1000).toLocaleDateString("ru-RU") : "";
        return escapeHtml(String(h.oldFinal)) + ' → <b>' + escapeHtml(String(h.newFinal)) + '</b> (' + d + ')';
      }).join(' · ');
      html += '</div>';
    }
    const tracks = group.album && group.album.tracks ? group.album.tracks : null;
    if (data.isSingle && data.details && data.details[0]) {
      const d = data.details[0];
      html += '<div style="font-size:.75rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin:10px 0 6px;">Критерии сингла</div>';
      html += '<div class="criteria-list">';
      MAIN_CRITERIA.forEach(c => { html += '<div class="crit-row"><span>' + c.emoji + ' ' + c.name + '</span><span class="v">' + (d[c.key] || "—") + '</span></div>'; });
      html += '<div class="crit-row"><span>🌌 Атмосфера / вайб</span><span class="v">' + (d.vibe || "—") + '</span></div>';
      html += '</div>';
    } else if (data.scores && data.scores.length > 0) {
      html += '<div style="font-size:.75rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 6px;">Треки</div>';
      html += '<div class="track-list-mini">';
      data.scores.forEach((score, i) => {
        const trackName = tracks && tracks[i] ? tracks[i].name : ("Трек " + (i + 1));
        const hasDetail = data.details && data.details[i];
        const detailBadge = hasDetail ? ' <span style="font-size:.65rem;color:var(--accent-3);">●</span>' : '';
        html += '<div class="track-line" data-track-idx="' + i + '" style="cursor:' + (hasDetail ? "pointer" : "default") + ';">' +
          '<span>' + (i + 1) + '. ' + escapeHtml(trackName) + detailBadge + '</span>' +
          '<span class="score-mini">' + score + '</span></div>';
        if (hasDetail) {
          html += '<div class="track-detail hidden" data-detail-for="' + i + '" style="padding:8px 12px; margin-bottom:6px; background:var(--panel); border-radius:8px; font-size:.78rem;">';
          MAIN_CRITERIA.forEach(c => {
            html += '<div style="display:flex; justify-content:space-between; padding:2px 0;"><span>' + c.emoji + ' ' + c.name + '</span><span style="color:var(--accent-3); font-weight:700;">' + (data.details[i][c.key] || "—") + '</span></div>';
          });
          html += '<div style="display:flex; justify-content:space-between; padding:2px 0; border-top:1px solid var(--border-soft); margin-top:4px; padding-top:4px;"><span>🌌 Атмосфера / вайб</span><span style="color:var(--vibe-1); font-weight:700;">' + (data.details[i].vibe || "—") + '</span></div>';
          html += '</div>';
        }
      });
      html += '</div>';
    }
    detail.innerHTML = html;
    detail.querySelectorAll('.track-line[data-track-idx]').forEach(line => {
      line.onclick = () => {
        const idx = line.dataset.trackIdx;
        const block = detail.querySelector('.track-detail[data-detail-for="' + idx + '"]');
        if (block) block.classList.toggle("hidden");
      };
    });
    rowEl.parentNode.insertBefore(detail, rowEl.nextSibling);
  } catch (e) { showToast("Ошибка: " + e.message); }
}
function closeBoardModal() {
  document.getElementById("boardModalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}
async function openCalculatorFromBoard() {
  if (!boardModalRelease) return;
  const g = boardModalRelease;
  closeBoardModal();
  switchNav("main");
  await loadAlbum({ id: g.album.id || g.releaseId, title: g.album.title, cover: g.album.artwork, source: g.source });
}


// ---------- WISHLIST (обёртки в main) ----------
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


    // ===== ЗАГОЛОВОК ПРОФИЛЯ =====
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

    // ===== СЛУШАЕТ СЕЙЧАС =====
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

    // ===== ОБЩАЯ СТАТИСТИКА =====
    html += '<div class="user-profile-stats">' +
      // Всего оценок
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + ratings.length + '</div>' +
        '<div class="ups-lbl">Всего оценок</div>' +
        '<div class="ups-sub">' + albums.length + ' альб · ' + singles.length + ' сингл</div>' +
      '</div>' +
      // Средний балл
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + (avgAll || "—") + '</div>' +
        '<div class="ups-lbl">Средний балл</div>' +
        (tierAll ? '<div class="ups-sub">' + tierAll.emoji + ' ' + tierAll.name + '</div>' : '<div class="ups-sub">—</div>') +
      '</div>' +
      // Альбомы
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + albums.length + '</div>' +
        '<div class="ups-lbl">Альбомов</div>' +
        '<div class="ups-sub">средний ' + (avgAlbums || "—") + '</div>' +
      '</div>' +
      // Синглы
      '<div class="user-profile-stat">' +
        '<div class="ups-num">' + singles.length + '</div>' +
        '<div class="ups-lbl">Синглов</div>' +
        '<div class="ups-sub">средний ' + (avgSingles || "—") + '</div>' +
      '</div>' +
    '</div>';

    // ===== ТОП-3 ЛУЧШИХ =====
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

    // ===== ТОП-3 ХУДШИХ =====
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

    // ===== КНОПКИ =====
    html += '<div class="user-profile-actions" style="margin-top:16px;">';
    if (isMe) {
      html += '<button class="btn-secondary" onclick="closeUserProfile();switchNav(\'profile\')">👤 Открыть мой профиль</button>';
    } else {
      html += '<button class="btn-secondary" onclick="closeUserProfile();openCompareWithUser(\'' + uid + '\')">⚖ Сравнить с моими</button>';
    }
    html += '<button class="btn-secondary" onclick="closeUserProfile()">Закрыть</button>';
    html += '</div>';

    content.innerHTML = html;

    // Клик по релизу — открыть расчёт или доску
    content.querySelectorAll(".user-top-item").forEach(el => {
      el.onclick = () => {
        const src = el.dataset.source;
        const rid = el.dataset.releaseId;
        closeUserProfile();
        const group = boardData.find(b => b.source === src && b.releaseId === String(rid));
        if (group) {
          switchNav("board");
          setTimeout(() => openBoardModal(group), 250);
        } else {
          switchNav("main");
          loadAlbum({ id: rid, title: "", cover: "", source: src });
        }
      };
    });
  } catch (e) {
    content.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}
function closeUserProfile() {
  document.getElementById("userProfileBackdrop").classList.remove("open");
  document.body.style.overflow = "";
  _userProfileViewUid = null;
}
async function openCompareWithUser(uid) {
  // Упрощённый вариант: открываем сравнение с моими
  openCompareSelector();
}

// ---------- АДМИН-ПАНЕЛЬ ----------
function renderAdmin() { switchAdminTab(currentAdminTab); }
function switchAdminTab(tab) {
  currentAdminTab = tab;
  document.querySelectorAll(".admin-tab").forEach(t => t.classList.toggle("active", t.dataset.admin === tab));
  const map = {
    dashboard: "adminDashboard", users: "adminUsers", reports: "adminReports",
    suggestions: "adminSuggestions", addrelease: "adminAddRelease",
    announcement: "adminAnnouncement", maintenance: "adminMaintenance"
  };
  Object.keys(map).forEach(k => {
    const el = document.getElementById(map[k]);
    if (el) el.classList.toggle("hidden", k !== tab);
  });
  if (tab === "dashboard") renderAdminDashboard();
  if (tab === "users") renderAdminUsers();
  if (tab === "reports") renderAdminReports();
  if (tab === "suggestions") renderAdminSuggestions();
  if (tab === "addrelease") renderAdminAddRelease();
  if (tab === "announcement") renderAdminAnnouncement();
  if (tab === "maintenance") renderAdminMaintenance();
}

async function renderAdminDashboard() {
  const el = document.getElementById("adminDashboard");
  el.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';
  try {
    const [ratingsSnap, usersSnap, commentsSnap, reportsSnap] = await Promise.all([
      getDocs(collection(db, "ratings")),
      getDocs(collection(db, "users")),
      getDocs(collection(db, "comments")),
      getDocs(collection(db, "reports"))
    ]);
    const ratings = ratingsSnap.docs.map(d => d.data()).filter(r => !r.hidden);
    const users = usersSnap.docs.map(d => d.data());
    const comments = commentsSnap.docs.map(d => d.data());
    const reports = reportsSnap.docs.map(d => d.data());
    const now = Date.now() / 1000;
    const last7 = ratings.filter(r => (now - (r.ts?.seconds || 0)) < 7 * 86400);
    const newUsers7 = users.filter(u => (now - (u.createdAt?.seconds || 0)) < 7 * 86400);
    const artistCount = {};
    ratings.forEach(r => { const a = r.album.artist; if (a) artistCount[a] = (artistCount[a] || 0) + 1; });
    const userCount = {};
    ratings.forEach(r => { userCount[r.nickname] = (userCount[r.nickname] || 0) + 1; });
    const avgAll = ratings.length ? Math.round(ratings.reduce((a, r) => a + r.final, 0) / ratings.length) : 0;
    // График: 30 дней
    const dayMap = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      dayMap[key] = 0;
    }
    ratings.forEach(r => {
      if (!r.ts?.seconds) return;
      const d = new Date(r.ts.seconds * 1000);
      const key = d.toISOString().slice(0, 10);
      if (key in dayMap) dayMap[key]++;
    });
    const days = Object.keys(dayMap);
    const maxDay = Math.max(...Object.values(dayMap), 1);
    let chartHtml = '<div class="chart-bars">';
    days.forEach((day, i) => {
      const c = dayMap[day];
      const h = c === 0 ? 3 : Math.max(6, (c / maxDay) * 90);
      chartHtml += '<div class="chart-bar' + (c === 0 ? ' empty' : '') + '" style="height:' + h + 'px" title="' + day + ': ' + c + '"></div>';
    });
    chartHtml += '</div><div class="chart-labels"><span>30 дней назад</span><span>Сегодня</span></div>';

    el.innerHTML =
      '<div class="admin-grid">' +
        '<div class="admin-card"><div class="ac-num">' + users.length + '</div><div class="ac-lbl">Пользователей</div></div>' +
        '<div class="admin-card"><div class="ac-num">' + ratings.length + '</div><div class="ac-lbl">Всего оценок</div></div>' +
        '<div class="admin-card"><div class="ac-num">' + last7.length + '</div><div class="ac-lbl">Оценок за 7 дней</div></div>' +
        '<div class="admin-card"><div class="ac-num">' + newUsers7.length + '</div><div class="ac-lbl">Новых за 7 дней</div></div>' +
        '<div class="admin-card"><div class="ac-num">' + comments.length + '</div><div class="ac-lbl">Комментариев</div></div>' +
        '<div class="admin-card"><div class="ac-num">' + reports.length + '</div><div class="ac-lbl">Жалоб</div></div>' +
        '<div class="admin-card"><div class="ac-num">' + avgAll + '</div><div class="ac-lbl">Средний балл сайта</div></div>' +
      '</div>' +
      '<div class="admin-chart"><h3>📈 Активность за 30 дней</h3>' + chartHtml + '</div>' +
      '<div style="margin-top:20px;"><h3 style="font-size:.95rem;color:var(--text);margin-bottom:10px;">🏆 Топ-5 активных</h3>' +
      (Object.entries(userCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) =>
        '<div style="padding:6px 0;font-size:.85rem;color:var(--text-mid);">' + escapeHtml(n) + ' — <b>' + c + '</b> оценок</div>').join("") ||
        '<div style="color:var(--text-dim);font-size:.85rem;">Нет данных</div>') + '</div>' +
      '<div style="margin-top:20px;"><h3 style="font-size:.95rem;color:var(--text);margin-bottom:10px;">🎤 Топ-5 артистов</h3>' +
      (Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) =>
        '<div style="padding:6px 0;font-size:.85rem;color:var(--text-mid);">' + escapeHtml(n) + ' — <b>' + c + '</b> оценок</div>').join("") ||
        '<div style="color:var(--text-dim);font-size:.85rem;">Нет данных</div>') + '</div>';
  } catch (e) { el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>'; }
}

async function renderAdminUsers() {
  const el = document.getElementById("adminUsers");
  el.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    const users = usersSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
    const ratingsSnap = await getDocs(collection(db, "ratings"));
    const ratings = ratingsSnap.docs.map(d => d.data());
    const bannedSnap = await getDocs(collection(db, "banned"));
    const bannedMap = {};
    bannedSnap.docs.forEach(d => { bannedMap[d.id] = d.data(); });
    el.innerHTML = "";
    users.sort((a, b) => (b.xp || 0) - (a.xp || 0));
    users.forEach(u => {
      const uRatings = ratings.filter(r => r.uid === u._id && !r.hidden);
      const avg = uRatings.length ? Math.round(uRatings.reduce((a, r) => a + r.final, 0) / uRatings.length) : 0;
      const ban = bannedMap[u._id];
      const isBanned = !!ban;
      const lvl = getLevelByXp(u.xp || 0);
      const row = document.createElement("div");
      row.className = "admin-user-row";
      let banText = "";
      if (isBanned) {
        if (ban.until && ban.until.seconds) {
          const d = new Date(ban.until.seconds * 1000);
          banText = ' 🚫 до ' + d.toLocaleDateString("ru-RU");
        } else {
          banText = ' 🚫 навсегда';
        }
      }
      const isThisAdmin = u._id === ADMIN_UID;
      const metaLine = isThisAdmin
        ? '👑 Администратор · ' + uRatings.length + ' оценок · средний ' + (avg || "—")
        : lvl.emoji + ' Ур.' + lvl.level + ' · ' + uRatings.length + ' оценок · средний ' + (avg || "—") + ' · ' + (u.xp || 0) + ' XP';
      row.innerHTML = '<div class="avatar-sm" style="background:' + colorFromString(u.nickname || "?") + '">' + escapeHtml(u.avatar || "🎵") + '</div>' +
        '<div class="info"><div class="nick">' + escapeHtml(u.nickname || "—") + ' ' + (isThisAdmin ? "👑" : "") + banText + '</div>' +
        '<div class="meta">' + metaLine + '</div></div>' +
        '<div class="actions">' +
          '<button class="btn-secondary" onclick="openUserProfile(\'' + u._id + '\')">👤 Профиль</button>' +
          (u._id !== ADMIN_UID
            ? '<button class="btn-secondary" onclick="resetUserProgress(\'' + u._id + '\',\'' + escapeHtml(u.nickname || "").replace(/'/g, "\\'") + '\')">↺ Сбросить прогресс</button>'
            : '') +
          (isBanned
            ? '<button onclick="unbanUser(\'' + u._id + '\')">Разбанить</button>'
            : (u._id !== ADMIN_UID ? '<button class="btn-danger" onclick="openBanModal(\'' + u._id + '\',\'' + escapeHtml(u.nickname || "").replace(/'/g, "\\'") + '\')">Забанить</button>' : '')) +
        '</div>';
      el.appendChild(row);
    });
  } catch (e) { el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>'; }
}

// ---------- ЖАЛОБЫ ----------
async function renderAdminReports() {
  const el = document.getElementById("adminReports");
  el.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';
  try {
    const snap = await getDocs(collection(db, "reports"));
    const reports = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    // Группируем по commentId
    const groups = {};
    reports.forEach(r => {
      if (!groups[r.commentId]) groups[r.commentId] = { commentId: r.commentId, source: r.source, releaseId: r.releaseId, reports: [] };
      groups[r.commentId].reports.push(r);
    });
    const list = Object.values(groups).sort((a, b) => b.reports.length - a.reports.length);
    // Обновляем badge
    const badge = document.getElementById("reportsBadge");
    if (badge) {
      if (list.length > 0) { badge.textContent = list.length; badge.style.display = "inline-flex"; badge.classList.remove("hidden"); }
      else { badge.style.display = "none"; badge.classList.add("hidden"); }
    }
    if (list.length === 0) {
      el.innerHTML = '<div class="empty-msg">Жалоб пока нет 🎉</div>';
      return;
    }
    el.innerHTML = "";
    for (const g of list) {
      // Загружаем коммент
      let commentData = null;
      try {
        const cs = await getDoc(doc(db, "comments", g.commentId));
        if (cs.exists()) commentData = cs.data();
      } catch (e) {}
      const div = document.createElement("div");
      div.className = "report-item";
      const count = g.reports.length;
      let commentHtml = '<div class="report-comment" style="color:var(--danger); font-style:italic;">Комментарий удалён</div>';
      if (commentData) {
        commentHtml = '<div class="report-comment">' +
          '<b style="color:var(--text);">' + escapeHtml(commentData.nickname || "—") + ':</b> ' + escapeHtml(commentData.text || "") +
        '</div>';
      }
      const reportersList = g.reports.map(r => escapeHtml(r.reporterNickname || "?")).join(", ");
      div.innerHTML =
        '<div class="head">' +
          '<span class="who">На релиз <b>' + escapeHtml(g.source) + '_' + escapeHtml(String(g.releaseId)) + '</b> · жалобщики: ' + reportersList + '</span>' +
          '<span class="report-count">🚨 ' + count + ' ' + plural(count, "жалоба", "жалобы", "жалоб") + '</span>' +
        '</div>' +
        commentHtml +
        '<div class="actions">' +
          (commentData ? '<button class="btn-secondary" onclick="adminJumpToComment(\'' + g.source + '\',\'' + g.releaseId + '\')">👁 Показать релиз</button>' : '') +
          '<button class="btn-danger" onclick="adminDeleteReportedComment(\'' + g.commentId + '\',\'' + g.source + '\',\'' + g.releaseId + '\')">🗑 Удалить комментарий</button>' +
          (commentData ? '<button class="btn-danger" onclick="openBanModal(\'' + (g.reports[0].reporterUid ? commentData.uid : commentData.uid) + '\',\'' + escapeHtml(commentData.nickname || "").replace(/'/g, "\\'") + '\')">🚫 Забанить автора</button>' : '') +
          '<button class="btn-secondary" onclick="clearCommentReports(\'' + g.commentId + '\')">✓ Жалобы обработаны</button>' +
        '</div>';
      el.appendChild(div);
    }
  } catch (e) { el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>'; }
}
async function adminJumpToComment(source, releaseId) {
  closeAdminReportsSafe();
  const group = boardData.find(b => b.source === source && b.releaseId === String(releaseId));
  if (group) {
    switchNav("board");
    setTimeout(() => openBoardModal(group), 300);
  } else {
    await refreshBoard();
    const g2 = boardData.find(b => b.source === source && b.releaseId === String(releaseId));
    if (g2) { switchNav("board"); setTimeout(() => openBoardModal(g2), 300); }
    else showToast("Релиз не найден на доске");
  }
}
function closeAdminReportsSafe() {
  // просто переключаем вкладку, чтобы не мешать
}
async function adminDeleteReportedComment(commentId, source, releaseId) {
  const ok = await showConfirm({
    icon: "🗑",
    title: "Удалить комментарий?",
    text: "Комментарий и все жалобы на него будут удалены.",
    okText: "Удалить",
    okClass: "btn-danger"
  });
  if (!ok) return;
  try {
    // Удаляем комментарий
    await deleteDoc(doc(db, "comments", commentId));
    // Удаляем жалобы
    const rs = await getDocs(query(collection(db, "reports"), where("commentId", "==", commentId)));
    await Promise.all(rs.docs.map(d => deleteDoc(doc(db, "reports", d.id))));
    showToast("Комментарий и жалобы удалены", { success: true });
    renderAdminReports();
  } catch (e) { showToast("Ошибка: " + e.message); }
}
async function clearCommentReports(commentId) {
  try {
    const rs = await getDocs(query(collection(db, "reports"), where("commentId", "==", commentId)));
    await Promise.all(rs.docs.map(d => deleteDoc(doc(db, "reports", d.id))));
    showToast("Жалобы обработаны", { success: true });
    renderAdminReports();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ---------- BAN MODAL ----------
function openBanModal(uid, nickname) {
  if (uid === ADMIN_UID) { showToast("Нельзя забанить админа"); return; }
  _banTargetUid = uid;
  _banSelectedDays = 7;
  document.getElementById("banModalNick").textContent = nickname || uid;
  document.getElementById("banReasonInput").value = "";
  document.getElementById("banUntilDate").value = "";
  document.querySelectorAll(".ban-duration-btn").forEach(b => b.classList.remove("btn-gold"));
  const defaultBtn = document.querySelector('.ban-duration-btn[data-days="7"]');
  if (defaultBtn) defaultBtn.classList.add("btn-gold");
  document.getElementById("banModalBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeBanModal() {
  document.getElementById("banModalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
  _banTargetUid = null;
}
function selectBanDuration(days) {
  _banSelectedDays = days;
  document.querySelectorAll(".ban-duration-btn").forEach(b => b.classList.toggle("btn-gold", parseInt(b.dataset.days) === days));
  document.getElementById("banUntilDate").value = "";
}
async function confirmBanUser() {
  if (!_banTargetUid) return;
  if (_banTargetUid === ADMIN_UID) { showToast("Нельзя забанить админа"); return; }
  const reason = document.getElementById("banReasonInput").value.trim();
  const dateVal = document.getElementById("banUntilDate").value;
  let until = null;
  if (dateVal) {
    until = new Date(dateVal + "T23:59:59");
  } else if (_banSelectedDays > 0) {
    until = new Date(Date.now() + _banSelectedDays * 86400000);
  }
  try {
    const banRef = doc(db, "banned", _banTargetUid);
    const payload = {
      ts: serverTimestamp(),
      reason: reason || null,
      by: currentUser.uid
    };
    if (until) payload.until = until;
    await setDoc(banRef, payload);
    // Помечаем все оценки и комменты юзера как скрытые
    const ratings = await getDocs(query(collection(db, "ratings"), where("uid", "==", _banTargetUid)));
    const comments = await getDocs(query(collection(db, "comments"), where("uid", "==", _banTargetUid)));
    await Promise.all([
      ...ratings.docs.map(d => updateDoc(doc(db, "ratings", d.id), { hidden: true })),
      ...comments.docs.map(d => updateDoc(doc(db, "comments", d.id), { hidden: true }))
    ]);
    showToast("Пользователь забанен", { success: true });
    closeBanModal();
    if (currentAdminTab === "users") renderAdminUsers();
    if (currentAdminTab === "reports") renderAdminReports();
    // Обновить доску
    if (boardData.length) refreshBoard();
  } catch (e) { showToast("Ошибка: " + e.message); }
}
// Сбросить уровень и ачивки пользователя (только админ)
async function resetUserProgress(uid, nickname) {
  if (!currentUser || currentUser.uid !== ADMIN_UID) {
    showToast("Только админ может сбрасывать прогресс");
    return;
  }
  if (uid === ADMIN_UID) {
    showToast("Нельзя сбросить прогресс админа");
    return;
  }
  const ok = await showConfirm({
    icon: "↺",
    title: "Сбросить прогресс?",
    text: "У пользователя «" + (nickname || uid) + "» будут обнулены: уровень, XP и все достижения. Оценки останутся на месте.",
    okText: "Сбросить",
    okClass: "btn-danger"
  });
  if (!ok) return;
  try {
    await updateDoc(doc(db, "users", uid), {
      xp: 0,
      achievements: []
    });
    showToast("Прогресс сброшен", { success: true });
    renderAdminUsers();
  } catch (e) {
    showToast("Ошибка: " + e.message);
  }
}
async function unbanUser(uid) {
  try {
    await deleteDoc(doc(db, "banned", uid));
    // Возвращаем видимость
    const ratings = await getDocs(query(collection(db, "ratings"), where("uid", "==", uid)));
    const comments = await getDocs(query(collection(db, "comments"), where("uid", "==", uid)));
    await Promise.all([
      ...ratings.docs.map(d => updateDoc(doc(db, "ratings", d.id), { hidden: false })),
      ...comments.docs.map(d => updateDoc(doc(db, "comments", d.id), { hidden: false }))
    ]);
    showToast("Пользователь разбанен", { success: true });
    renderAdminUsers();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ---------- ПРЕДЛОЖЕНИЯ ----------
async function renderAdminSuggestions() {
  const el = document.getElementById("adminSuggestions");
  el.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';
  try {
    const snap = await getDocs(collection(db, "suggestions"));
    const items = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    items.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
    if (items.length === 0) { el.innerHTML = '<div class="empty-msg">Пока нет предложений.</div>'; return; }
    el.innerHTML = "";
    items.forEach(s => {
      const div = document.createElement("div");
      div.className = "admin-suggestion";
      const statusColor = s.status === "approved" ? "var(--accent-3)" : s.status === "rejected" ? "var(--danger)" : "var(--text-dim)";
      div.innerHTML = '<div class="head"><span class="who">' + escapeHtml(s.nickname || "?") + ' · ' + (s.ts?.seconds ? formatTime(s.ts.seconds) : "") + '</span>' +
        '<span style="font-size:.75rem;color:' + statusColor + '; text-transform:uppercase; font-weight:700;">' + (s.status || "pending") + '</span></div>' +
        '<div class="body"><b>' + escapeHtml(s.title || "") + '</b> — ' + escapeHtml(s.artist || "") + '<br>' + escapeHtml(s.comment || "") + '</div>' +
        '<div class="actions">' + (s.status === "pending"
          ? '<button onclick="approveSuggestion(\'' + s._id + '\')">✓ Одобрить и создать релиз</button>' +
            '<button class="btn-secondary" onclick="rejectSuggestion(\'' + s._id + '\')">✗ Отклонить</button>'
          : "") +
        '<button class="btn-secondary" onclick="deleteSuggestion(\'' + s._id + '\')">Удалить</button></div>';
      el.appendChild(div);
    });
  } catch (e) { el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>'; }
}
async function approveSuggestion(id) {
  try {
    const snap = await getDoc(doc(db, "suggestions", id));
    if (!snap.exists()) return;
    const data = snap.data();
    const releaseKey = "custom_" + id;
    await setDoc(doc(db, "overrides", releaseKey), {
      title: data.title || "", artist: data.artist || "", artwork: "", tracks: [],
      manual: true, createdBy: currentUser.uid, updatedAt: serverTimestamp()
    });
    await updateDoc(doc(db, "suggestions", id), { status: "approved", releaseKey });
    if (data.uid) await notifyUser(data.uid, "✅ Ваше предложение «" + (data.title || "релиз") + "» одобрено");
    showToast("Одобрено, релиз создан", { success: true });
    renderAdminSuggestions();
  } catch (e) { showToast("Ошибка: " + e.message); }
}
async function rejectSuggestion(id) {
  try {
    const snap = await getDoc(doc(db, "suggestions", id));
    const data = snap.exists() ? snap.data() : {};
    await updateDoc(doc(db, "suggestions", id), { status: "rejected" });
    if (data.uid) await notifyUser(data.uid, "❌ Ваше предложение «" + (data.title || "релиз") + "» отклонено");
    showToast("Отклонено"); renderAdminSuggestions();
  } catch (e) { showToast("Ошибка"); }
}
async function deleteSuggestion(id) {
  const ok = await showConfirm({
    icon: "🗑",
    title: "Удалить предложение?",
    text: "Заявка будет удалена безвозвратно.",
    okText: "Удалить",
    okClass: "btn-danger"
  });
  if (!ok) return;
  try { await deleteDoc(doc(db, "suggestions", id)); renderAdminSuggestions(); }
  catch (e) { showToast("Ошибка"); }
}

// ---------- ДОБАВЛЕНИЕ РЕЛИЗА ----------
function renderAdminAddRelease() {
  const el = document.getElementById("adminAddRelease");
  el.innerHTML =
    '<div class="hint" style="margin-bottom:12px;">Создайте релиз вручную. Он появится в поиске и станет доступен для оценки.</div>' +
    '<label>Название релиза</label><input type="text" id="addReleaseTitle" placeholder="Например: In Rainbows" style="margin-bottom:10px;">' +
    '<label>Артист</label><input type="text" id="addReleaseArtist" placeholder="Например: Radiohead" style="margin-bottom:10px;">' +
    '<label>Обложка (URL, необязательно)</label><input type="text" id="addReleaseArtwork" placeholder="https://…" style="margin-bottom:10px;">' +
    '<label>Треки (построчно)</label><textarea id="addReleaseTracks" placeholder="Трек 1&#10;Трек 2&#10;Трек 3"></textarea>' +
    '<div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;"><button onclick="createRelease()">💾 Создать релиз</button></div>';
}
async function createRelease() {
  const title = document.getElementById("addReleaseTitle").value.trim();
  const artist = document.getElementById("addReleaseArtist").value.trim();
  const artwork = document.getElementById("addReleaseArtwork").value.trim();
  const tracksText = document.getElementById("addReleaseTracks").value;
  const tracks = tracksText.split("\n").map(s => s.trim()).filter(Boolean);
  if (!title || !artist) { showToast("Заполните название и артиста"); return; }
  if (tracks.length === 0) { showToast("Добавьте хотя бы один трек"); return; }
  try {
    const releaseKey = "custom_" + Date.now();
    await setDoc(doc(db, "overrides", releaseKey), {
      title, artist, artwork, tracks, manual: true,
      createdBy: currentUser.uid, updatedAt: serverTimestamp()
    });
    // Лента
    await pushActivity({
      type: "release",
      uid: currentUser.uid,
      nickname: userProfile.nickname,
      avatar: userProfile.avatar || "🎵",
      releaseId: releaseKey,
      releaseTitle: title,
      releaseArtist: artist,
      releaseArtwork: artwork,
      source: "custom"
    });
    showToast("Релиз создан", { success: true });
    document.getElementById("addReleaseTitle").value = "";
    document.getElementById("addReleaseArtist").value = "";
    document.getElementById("addReleaseArtwork").value = "";
    document.getElementById("addReleaseTracks").value = "";
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ---------- ОБЪЯВЛЕНИЕ ----------
function renderAdminAnnouncement() {
  const el = document.getElementById("adminAnnouncement");
  if (!el) return;
  const ann = siteSettings.announcement;
  const hasActive = ann && ann.id && ann.text;
  el.innerHTML =
    '<div class="hint" style="margin-bottom:12px;">Объявление увидят все пользователи. После закрытия больше не появится (пока не создадите новое).</div>' +
    (hasActive ? '<div class="ai-recommendation" style="margin-bottom:14px;"><b>Активное:</b> ' + escapeHtml(ann.text) + '</div>' : '') +
    '<label>Текст объявления</label>' +
    '<textarea id="announcementInput" maxlength="300" placeholder="Например: Мы обновились! Новые фичи уже здесь 🎉"></textarea>' +
    '<div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;">' +
      '<button onclick="publishAnnouncement()">📢 Опубликовать</button>' +
      (hasActive ? '<button class="btn-secondary" onclick="deleteAnnouncement()">🗑 Удалить</button>' : '') +
    '</div>';
}
async function publishAnnouncement() {
  const text = document.getElementById("announcementInput").value.trim();
  if (!text) { showToast("Введите текст"); return; }
  try {
    const id = "ann_" + Date.now();
    await setDoc(doc(db, "settings", "site"), {
      announcement: { id, text, ts: new Date().toISOString() }
    }, { merge: true });
    showToast("Объявление опубликовано", { success: true });
    renderAdminAnnouncement();
  } catch (e) { showToast("Ошибка: " + e.message); }
}
async function deleteAnnouncement() {
  const ok = await showConfirm({
    icon: "🗑",
    title: "Удалить объявление?",
    text: "Оно исчезнет у всех пользователей.",
    okText: "Удалить",
    okClass: "btn-danger"
  });
  if (!ok) return;
  try {
    await updateDoc(doc(db, "settings", "site"), { announcement: null });
    showToast("Удалено");
    renderAdminAnnouncement();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ---------- РЕДАКТИРОВАНИЕ РЕЛИЗА ----------
function adminEditRelease() {
  if (!currentAlbum) return;
  document.getElementById("editTitle").value = currentAlbum.title;
  document.getElementById("editArtist").value = currentAlbum.artist;
  document.getElementById("editArtwork").value = currentAlbum.artwork;
  document.getElementById("editTracks").value = currentTracks.map(t => t.name).join("\n");
  document.getElementById("editReleaseBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeEditRelease() {
  document.getElementById("editReleaseBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}
async function saveEditRelease() {
  if (!currentAlbum) return;
  const key = currentAlbum.source + "_" + currentAlbum.id;
  const tracks = document.getElementById("editTracks").value.split("\n").map(s => s.trim()).filter(Boolean);
  try {
    await setDoc(doc(db, "overrides", key), {
      title: document.getElementById("editTitle").value.trim(),
      artist: document.getElementById("editArtist").value.trim(),
      artwork: document.getElementById("editArtwork").value.trim(),
      tracks, updatedAt: serverTimestamp(), updatedBy: currentUser.uid
    });
    showToast("Правки сохранены", { success: true });
    closeEditRelease();
    currentAlbum.title = document.getElementById("editTitle").value.trim();
    currentAlbum.artist = document.getElementById("editArtist").value.trim();
    currentAlbum.artwork = document.getElementById("editArtwork").value.trim();
    currentTracks = tracks.map(n => ({ name: n, artist: currentAlbum.artist }));
    renderAlbum();
  } catch (e) { showToast("Ошибка: " + e.message); }
}
async function resetEditRelease() {
  if (!currentAlbum) return;
  const ok = await showConfirm({
    icon: "↺",
    title: "Сбросить правки?",
    text: "Все ручные изменения этого релиза будут удалены, вернётся оригинал из источника.",
    okText: "Сбросить",
    okClass: "btn-danger"
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "overrides", currentAlbum.source + "_" + currentAlbum.id));
    showToast("Правки сброшены");
    closeEditRelease();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ---------- УДАЛЕНИЕ РЕЛИЗА С ДОСКИ ----------
async function adminDeleteReleaseFromBoard() {
  if (!boardModalRelease) return;
  const ok = await showConfirm({
    icon: "⚠️",
    title: "Удалить релиз с доски?",
    text: "Будут удалены ВСЕ оценки этого релиза от всех пользователей, а также комментарии. Действие необратимо.",
    okText: "Удалить всё",
    okClass: "btn-danger"
  });
  if (!ok) return;
  const group = boardModalRelease;
  const btn = document.querySelector("#adminBoardQuick button");
  if (btn) { btn.disabled = true; btn.textContent = "Удаление…"; }
  showFloatingLoader(true);
  try {
    const ratingsQuery = query(
      collection(db, "ratings"),
      where("source", "==", group.source),
      where("releaseId", "==", String(group.releaseId))
    );
    const ratingsSnap = await getDocs(ratingsQuery);
    const deleteRatings = ratingsSnap.docs.map(d => deleteDoc(doc(db, "ratings", d.id)));
    const releaseKey = group.source + "_" + group.releaseId;
    const commentsQuery = query(
      collection(db, "comments"),
      where("releaseKey", "==", releaseKey)
    );
    const commentsSnap = await getDocs(commentsQuery);
    const deleteComments = commentsSnap.docs.map(d => deleteDoc(doc(db, "comments", d.id)));
    const wishlistQuery = query(
      collection(db, "wishlist"),
      where("source", "==", group.source),
      where("releaseId", "==", String(group.releaseId))
    );
    const wishlistSnap = await getDocs(wishlistQuery);
    const deleteWishlist = wishlistSnap.docs.map(d => deleteDoc(doc(db, "wishlist", d.id)));
    await Promise.all([...deleteRatings, ...deleteComments, ...deleteWishlist]);
    boardData = boardData.filter(b => !(b.source === group.source && b.releaseId === group.releaseId));
    myRatings = myRatings.filter(r => !(r.source === group.source && r.releaseId === String(group.releaseId)));
    closeBoardModal();
    renderBoard();
    renderBoardDynamicStats();
    updateUserRatingCount();
    showToast(`Релиз удалён: ${ratingsSnap.docs.length} ${plural(ratingsSnap.docs.length, "оценка", "оценки", "оценок")}`, { success: true });
  } catch (e) {
    showToast("Ошибка удаления: " + e.message);
  } finally {
    showFloatingLoader(false);
  }
}




// ---------- AI RECOMMENDATION ----------
async function showAiRecommendation() {
  const el = document.getElementById("aiReco");
  if (!myRatings.length) { el.classList.add("hidden"); return; }
  const favArtist = getFavoriteArtist();
  const avgFinal = Math.round(myRatings.reduce((a, r) => a + r.final, 0) / myRatings.length);
  const tier = getTier(avgFinal);
  let text = "";
  if (favArtist) {
    text = '💡 Вам нравится <b>' + escapeHtml(favArtist) + '</b>. Поищите другие их релизы через поиск.';
  } else {
    text = '💡 Ваш средний балл — <b>' + avgFinal + '</b> (уровень <b>' + tier.emoji + ' ' + tier.name + '</b>).';
  }
  el.innerHTML = text;
  el.classList.remove("hidden");
}

// ---------- SUGGEST ----------
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

// ---------- SHARE (заглушка, будет в финальном патче) ----------
function openShareDialog() {
  if (!currentAlbum) { showToast("Сначала выберите релиз"); return; }
  showToast("📤 Шеринг-карточка скоро появится", { gold: true });
}


// ---------- KEYDOWN ----------
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
  } else if (e.key === "Enter" && currentAlbum && currentTracks.length > 0) {
    const inMain = !document.getElementById("navMain").classList.contains("hidden");
    if (inMain) { e.preventDefault(); submitRating(); }
  } else if (/^[0-9]$/.test(e.key) && currentAlbum && currentTracks.length > 0) {
    if (document.getElementById("modalBackdrop").classList.contains("open")) {
      const v = e.key === "0" ? 10 : parseInt(e.key);
      modalValues[VIBE_KEY] = v;
      updateCriterionVal(VIBE_KEY, v);
      updateModalTotal();
    }
  }
});

// ---------- MOBILE NAV AUTOHIDE ----------
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

// ---------- MISC UTILS ----------
function cleanTrackTitle(t) { return String(t).replace(/^[A-Z]?\d+[-.]?\d*\s+/, "").trim(); }

// ---------- CLICK OUTSIDE AUTOCOMPLETE ----------
document.addEventListener("mousedown", (e) => {
  const wrap = document.querySelector(".autocomplete-wrap");
  if (wrap && !wrap.contains(e.target)) closeSuggestions();
  const npWrap = document.querySelector("#nowPlayingModal .autocomplete-wrap");
  if (npWrap && !npWrap.contains(e.target)) {
    const npList = document.getElementById("nowPlayingSuggestions");
    if (npList) npList.classList.remove("open");
  }
});

// ---------- TOUCH SWIPES ----------
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

// ---------- WINDOW EXPORTS ----------
window.handleAuthSubmit = handleAuthSubmit;
window.toggleAuthMode = toggleAuthMode;
window.handleLogout = handleLogout;
window.cycleTheme = cycleTheme;
window.switchNav = switchNav;
window.goHome = goHome;
window.setRatingMode = setRatingMode;
window.setSource = setSource;
window.onSearchInput = onSearchInput;
window.onSearchKeydown = onSearchKeydown;
window.showSuggestions = showSuggestions;
window.checkShowSuggestions = function() { if (typeof lastSuggestions !== "undefined" && lastSuggestions.length) showSuggestions(); };
window.openBoardModal = openBoardModal;
window.closeBoardModal = closeBoardModal;
window.openCalculatorFromBoard = openCalculatorFromBoard;
window.refreshBoard = refreshBoard;
window.onBoardSearchInput = onBoardSearchInput;
window.renderHistory = renderHistory;
window.switchTopTab = switchTopTab;
window.switchAdminTab = switchAdminTab;
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
window.closeModal = closeModal;
window.toggleHelp = toggleHelp;
window.toggleHelpSingle = toggleHelpSingle;
window.applyModalRating = applyModalRating;
window.rateTrackAsSingle = rateTrackAsSingle;
window.submitRating = submitRating;
window.reset = reset;
window.toggleHistogram = toggleHistogram;
window.onCoverRatingChange = onCoverRatingChange;
window.updateCoverBadge = updateCoverBadge;
window.addToWishlist = addToWishlist;
window.rateFromWishlist = rateFromWishlist;
window.removeFromWishlist = removeFromWishlist;
window.openRandomWishlist = openRandomWishlist;
window.openCompareSelector = openCompareSelector;
window.compareGo = compareGo;
window.compareBack = compareBack;
window.closeCompareModal = closeCompareModal;
window.openNotifications = openNotifications;
window.closeNotifications = closeNotifications;
window.continueDraft = continueDraft;
window.dismissDraft = dismissDraft;
window.openProfile = () => switchNav("profile");
window.saveNickname = saveNickname;
window.selectAvatar = selectAvatar;
window.selectScheme = selectScheme;
window.adminEditRelease = adminEditRelease;
window.closeEditRelease = closeEditRelease;
window.saveEditRelease = saveEditRelease;
window.resetEditRelease = resetEditRelease;
window.adminDeleteReleaseFromBoard = adminDeleteReleaseFromBoard;
window.openSuggest = openSuggest;
window.closeSuggest = closeSuggest;
window.submitSuggestion = submitSuggestion;
window.showConfirm = showConfirm;
window.closeConfirm = closeConfirm;
window.openMaintenanceModal = openMaintenanceModal;
window.closeMaintenanceModal = closeMaintenanceModal;
window.saveMaintenanceSettings = saveMaintenanceSettings;
window.toggleMaintenance = toggleMaintenance;
window.dismissAnnouncement = dismissAnnouncement;
window.publishAnnouncement = publishAnnouncement;
window.deleteAnnouncement = deleteAnnouncement;
window.refreshFeed = refreshFeed;
window.switchFeedTab = switchFeedTab;
window.reportComment = reportComment;
window.replyToComment = replyToComment;
window.openUserProfile = openUserProfile;
window.closeUserProfile = closeUserProfile;
window.openCompareWithUser = openCompareWithUser;
window.openNowPlayingPicker = openNowPlayingPicker;
window.closeNowPlayingPicker = closeNowPlayingPicker;
window.onNowPlayingSearchInput = onNowPlayingSearchInput;
window.onNowPlayingKeydown = onNowPlayingKeydown;
window.clearNowPlaying = clearNowPlaying;
window.openShareDialog = openShareDialog;
window.adminJumpToComment = adminJumpToComment;
window.adminDeleteReportedComment = adminDeleteReportedComment;
window.clearCommentReports = clearCommentReports;

// ---------- INIT ----------
initTheme();
initRatingMode();
initSource();
setupMobileNavAutoHide();
setupOfflineDetection();
loadLocalReported();

// Подписка на обновления из window для точечных правок
window._db = db;
window._auth = auth;
window._fbFns = {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where,
  getDocs, addDoc, serverTimestamp, onSnapshot, orderBy, fbLimit
};
window._adminUid = ADMIN_UID;