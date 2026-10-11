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

import {
  cacheGet, cacheSet,
  cacheCover, getCachedCoverBlob,
  scheduleCoverCaching, hydrateImagesFromCache
} from './cache.js';


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
let currentScheme = "";

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

// ---------- ТЕХРАБОТЫ + ОБЪЯВЛЕНИЯ ----------
async function loadSiteSettingsOnce() {
  try {
    const snap = await getDoc(doc(db, "settings", "site"));
    if (snap.exists()) {
      siteSettings = snap.data();
    } else {
      siteSettings = { maintenance: false, maintenanceMessage: "", announcement: null };
    }
  } catch (e) {
    siteSettings = { maintenance: false, maintenanceMessage: "", announcement: null };
  }
  applyMaintenanceState();
  applyAnnouncementState();
}
function subscribeSiteSettings() {
  if (_settingsUnsub) _settingsUnsub();
  try {
    _settingsUnsub = onSnapshot(doc(db, "settings", "site"), (snap) => {
      if (snap.exists()) siteSettings = snap.data();
      else siteSettings = { maintenance: false, maintenanceMessage: "", announcement: null };
      applyMaintenanceState();
      applyAnnouncementState();
    }, () => {});
  } catch (e) {}
}
function startMaintenancePolling() {
  if (_maintenancePollTimer) clearInterval(_maintenancePollTimer);
  _maintenancePollTimer = setInterval(() => {
    if (siteSettings.maintenance && currentUser && currentUser.uid !== ADMIN_UID) {
      loadSiteSettingsOnce();
    }
  }, 30000);
}
function applyMaintenanceState() {
  const isAdmin = currentUser && currentUser.uid === ADMIN_UID;
  const isOn = !!siteSettings.maintenance;
  const screen = document.getElementById("maintenanceScreen");
  const banner = document.getElementById("maintenanceAdminBanner");
  const authContainer = document.getElementById("authContainer");
  const mainContainer = document.getElementById("mainContainer");
  if (!screen) return;
  const msg = (siteSettings.maintenanceMessage || "").trim() || MAINTENANCE_DEFAULT_MSG;
  document.getElementById("maintenanceText").textContent = msg;
  const meta = document.getElementById("maintenanceMeta");
  if (isOn && siteSettings.maintenanceStartedAt) {
    try {
      const startedAt = siteSettings.maintenanceStartedAt.seconds
        ? new Date(siteSettings.maintenanceStartedAt.seconds * 1000)
        : new Date(siteSettings.maintenanceStartedAt);
      meta.textContent = "Начались: " + startedAt.toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    } catch (e) { meta.textContent = ""; }
  } else {
    meta.textContent = "";
  }
  if (isOn && !isAdmin) {
    screen.classList.remove("hidden");
    if (authContainer) authContainer.classList.add("hidden");
    if (mainContainer) mainContainer.classList.add("hidden");
    if (banner) banner.classList.add("hidden");
    document.body.classList.remove("has-admin-banner");
  } else {
    screen.classList.add("hidden");
    if (isOn && isAdmin) {
      if (banner) banner.classList.remove("hidden");
      document.body.classList.add("has-admin-banner");
    } else {
      if (banner) banner.classList.add("hidden");
      document.body.classList.remove("has-admin-banner");
    }
  }
}
function applyAnnouncementState() {
  const banner = document.getElementById("announcementBanner");
  if (!banner) return;
  const ann = siteSettings.announcement;
  if (!ann || !ann.id || !ann.text) {
    banner.classList.add("hidden");
    return;
  }
  let seenId = null;
  try { seenId = localStorage.getItem(LS_ANNOUNCEMENT); } catch (e) {}
  if (seenId === ann.id) {
    banner.classList.add("hidden");
    return;
  }
  document.getElementById("announcementText").textContent = ann.text;
  banner.classList.remove("hidden");
}
function dismissAnnouncement() {
  const ann = siteSettings.announcement;
  if (ann && ann.id) {
    try { localStorage.setItem(LS_ANNOUNCEMENT, ann.id); } catch (e) {}
  }
  document.getElementById("announcementBanner").classList.add("hidden");
}
function openMaintenanceModal() {
  if (!currentUser || currentUser.uid !== ADMIN_UID) return;
  const input = document.getElementById("maintenanceMessageInput");
  input.value = siteSettings.maintenanceMessage || "";
  const row = document.getElementById("maintenanceStatusRow");
  const text = document.getElementById("maintenanceStatusText");
  const toggleBtn = document.getElementById("maintenanceToggleBtn");
  const isOn = !!siteSettings.maintenance;
  row.classList.toggle("on", isOn);
  text.textContent = isOn ? "Сейчас: включено" : "Сейчас: выключено";
  toggleBtn.textContent = isOn ? "Отключить" : "Включить";
  toggleBtn.className = isOn ? "btn-secondary" : "btn-danger";
  document.getElementById("maintenanceBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeMaintenanceModal() {
  document.getElementById("maintenanceBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}
async function saveMaintenanceSettings() {
  if (!currentUser || currentUser.uid !== ADMIN_UID) return;
  const message = document.getElementById("maintenanceMessageInput").value.trim();
  try {
    await setDoc(doc(db, "settings", "site"), {
      maintenance: !!siteSettings.maintenance,
      maintenanceMessage: message,
      maintenanceStartedAt: siteSettings.maintenanceStartedAt || null,
      updatedAt: serverTimestamp()
    }, { merge: true });
    showToast("Сообщение сохранено", { success: true });
    closeMaintenanceModal();
  } catch (e) {
    showToast("Ошибка: " + e.message);
  }
}
async function toggleMaintenance() {
  if (!currentUser || currentUser.uid !== ADMIN_UID) return;
  const isOn = !!siteSettings.maintenance;
  if (!isOn) {
    const ok = await showConfirm({
      icon: "🔧",
      title: "Включить техработы?",
      text: "Сайт станет недоступен для всех пользователей, кроме вас. Вы сможете выключить режим в любой момент.",
      okText: "Включить",
      okClass: "btn-danger"
    });
    if (!ok) return;
  }
  const message = document.getElementById("maintenanceMessageInput")
    ? document.getElementById("maintenanceMessageInput").value.trim()
    : (siteSettings.maintenanceMessage || "");
  try {
    await setDoc(doc(db, "settings", "site"), {
      maintenance: !isOn,
      maintenanceMessage: message,
      maintenanceStartedAt: !isOn ? serverTimestamp() : null,
      maintenanceBy: currentUser.uid,
      updatedAt: serverTimestamp()
    }, { merge: true });
    showToast(!isOn ? "Техработы включены" : "Техработы выключены", { success: !isOn, gold: isOn });
    closeMaintenanceModal();
  } catch (e) {
    showToast("Ошибка: " + e.message);
  }
}
function renderAdminMaintenance() {
  const el = document.getElementById("adminMaintenance");
  if (!el) return;
  const isOn = !!siteSettings.maintenance;
  el.innerHTML =
    '<div class="admin-card" style="max-width:560px;">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap;">' +
        '<div>' +
          '<div style="font-size:1rem; font-weight:700; color:var(--text); margin-bottom:6px;">Режим техработ</div>' +
          '<div style="font-size:.82rem; color:var(--text-dim);">' +
            (isOn ? "🔴 Сейчас включён — сайт видят только админы" : "🟢 Сейчас выключен — сайт доступен всем") +
          '</div>' +
        '</div>' +
        '<button onclick="openMaintenanceModal()">⚙️ Настроить</button>' +
      '</div>' +
    '</div>';
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

// ---------- CONFIRM MODAL ----------
let _confirmResolve = null;
function showConfirm(opts) {
  opts = opts || {};
  const backdrop = document.getElementById("confirmBackdrop");
  const icon = document.getElementById("confirmIcon");
  const title = document.getElementById("confirmTitle");
  const text = document.getElementById("confirmText");
  const okBtn = document.getElementById("confirmOkBtn");
  const cancelBtn = document.getElementById("confirmCancelBtn");
  icon.textContent = opts.icon || "⚠️";
  title.textContent = opts.title || "Подтвердите действие";
  text.textContent = opts.text || "Вы уверены?";
  okBtn.textContent = opts.okText || "Удалить";
  cancelBtn.textContent = opts.cancelText || "Отмена";
  okBtn.className = opts.okClass || "btn-danger";
  okBtn.onclick = () => closeConfirm(true);
  cancelBtn.onclick = () => closeConfirm(false);
  backdrop.classList.add("open");
  document.body.style.overflow = "hidden";
  return new Promise((resolve) => { _confirmResolve = resolve; });
}
function closeConfirm(result) {
  const backdrop = document.getElementById("confirmBackdrop");
  backdrop.classList.remove("open");
  document.body.style.overflow = "";
  if (_confirmResolve) {
    _confirmResolve(result);
    _confirmResolve = null;
  }
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

// ---------- COLOR SCHEME ----------
function applySchemeFromProfile() {
  const scheme = (userProfile && userProfile.scheme) || "default";
  applyScheme(scheme);
}
function applyScheme(schemeId) {
  const all = SCHEMES.map(s => s.class).filter(Boolean);
  document.body.classList.remove(...all);
  const s = SCHEMES.find(x => x.id === schemeId) || SCHEMES[0];
  if (s.class) document.body.classList.add(s.class);
  currentScheme = schemeId;
}
function saveSchemeLocally(schemeId) {
  try { localStorage.setItem(SCHEME_KEY, schemeId); } catch (e) {}
}
function loadSchemeLocally() {
  try { return localStorage.getItem(SCHEME_KEY) || "default"; } catch (e) { return "default"; }
}

function initTheme() {
  const saved = localStorage.getItem(LS_THEME) || "auto";
  applyTheme(saved);
}
function applyTheme(theme) {
  document.body.classList.remove("light", "night");
  let icon = "🌙";
  if (theme === "light") { document.body.classList.add("light"); icon = "☀️"; }
  else if (theme === "night") { document.body.classList.add("night"); icon = "🌑"; }
  else {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      document.body.classList.add("light"); icon = "☀️";
    }
  }
  const btn = document.getElementById("themeBtn");
  if (btn) {
    btn.textContent = icon;
    btn.dataset.tooltip = "Тема: " + (theme === "auto" ? "по системе" : theme === "light" ? "светлая" : "ночная");
  }
}
function cycleTheme() {
  const cur = localStorage.getItem(LS_THEME) || "auto";
  const next = cur === "auto" ? "light" : cur === "light" ? "night" : "auto";
  localStorage.setItem(LS_THEME, next);
  applyTheme(next);
  const names = { auto: "по системе", light: "светлая", night: "ночная" };
  showToast("Тема: " + names[next]);
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

// ---------- JSONP ----------
let jsonpCounter = 0;
function jsonp(url, timeoutMs) {
  timeoutMs = timeoutMs || 12000;
  return new Promise((resolve, reject) => {
    const cb = "__jsonp_" + (++jsonpCounter) + "_" + Date.now();
    const script = document.createElement("script");
    const cleanup = () => {
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    };
    window[cb] = (data) => { cleanup(); resolve(data); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Таймаут")); }, timeoutMs);
    script.onerror = () => { cleanup(); reject(new Error("Ошибка загрузки")); };
    script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
    document.head.appendChild(script);
  });
}

// ---------- iTUNES / DEEZER ----------
// Spotify API через прокси
async function spotifyFetch(path) {
  const target = "https://api.spotify.com/v1" + path;
  const res = await fetch(ITUNES_PROXY + "?u=" + encodeURIComponent(target));
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Spotify HTTP " + res.status + ": " + text.slice(0, 120));
  }
  return res.json();
}

// Поиск альбомов (включая синглы) по запросу
async function spotifySearchAlbums(query, limit) {
  limit = limit || 20;
  // Убираем limit из URL — Spotify багует с ним через прокси.
  const data = await spotifyFetch(
    "/search?q=" + encodeURIComponent(query) + "&type=album"
  );
  const items = (data.albums && data.albums.items) || [];
  return items.slice(0, Math.max(1, Math.min(50, limit)));
}

// Загрузка альбома с трек-листом
async function spotifyGetAlbum(id) {
  return spotifyFetch("/albums/" + id);
}
function mapSpotifyAlbum(a) {
  const artistNames = (a.artists || []).map(x => x.name).join(", ");
  const rawCover = (a.images && a.images[0] && a.images[0].url) ||
                   (a.images && a.images[1] && a.images[1].url) || "";
  const cover = rawCover
    ? ITUNES_PROXY + "?u=" + encodeURIComponent(rawCover)
    : "";
  const year = (a.release_date || "").slice(0, 4);
  return {
    id: a.id,
    title: a.name,
    artist: artistNames,
    cover: cover,
    year: year,
    source: "spotify",
    trackCount: a.total_tracks || 0,
    isSingle: (a.album_type === "single") || (a.total_tracks === 1)
  };
}

// ---------- ПОИСК ----------
function onSearchInput() {
  const q = document.getElementById("searchInput").value.trim();
  clearTimeout(debounceTimer);
  if (q.length < 2) { lastSuggestions = []; activeIndex = -1; closeSuggestions(); return; }
  renderSkeletonSuggestions();
  debounceTimer = setTimeout(() => fetchSuggestions(q), DEBOUNCE_MS);
}
function renderSkeletonSuggestions() {
  const list = document.getElementById("suggestionList");
  list.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const el = document.createElement("div");
    el.className = "suggestion-skeleton";
    el.innerHTML = '<div class="sk-cover"></div><div class="sk-text"><div class="sk-line"></div><div class="sk-line short"></div></div>';
    list.appendChild(el);
  }
  list.classList.add("open");
}
async function fetchSuggestions(q) {
  try {
    const cacheKey = "spotify|" + q.toLowerCase();
    const cached = cacheGet(LS_SEARCH_CACHE, cacheKey);
    if (cached && cached.length) {
      lastSuggestions = cached.slice(0, 20);
      activeIndex = -1;
      renderSuggestions();
      return;
    }
    const albums = await spotifySearchAlbums(q, 20);
    const items = albums.map(mapSpotifyAlbum);
    if (items.length === 0) {
      lastSuggestions = [];
      renderStatus("Ничего не найдено");
      return;
    }
    cacheSet(LS_SEARCH_CACHE, cacheKey, items);
    lastSuggestions = items.slice(0, 20);
    activeIndex = -1;
    renderSuggestions();
    hideWarning();
  } catch (e) {
    console.error("Spotify search error:", e);
    lastSuggestions = [];
    renderStatus("Ошибка поиска");
    showWarning("🎧 Spotify: " + e.message);
  }
}
function renderSuggestions() {
  const list = document.getElementById("suggestionList");
  list.innerHTML = "";
  lastSuggestions.forEach((album, i) => {
    const el = document.createElement("div");
    el.className = "suggestion" + (i === activeIndex ? " active" : "");
    el.dataset.index = i;
    el.innerHTML = '<img src="' + escapeHtml(album.cover) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="text"><div class="t">' + escapeHtml(album.title) + '</div><div class="a">' + escapeHtml(album.artist) + '</div></div>';
    el.onmousedown = (e) => { e.preventDefault(); chooseSuggestion(i); };
    el.onmouseenter = () => { activeIndex = i; updateActiveHighlight(); };
    list.appendChild(el);
  });
  list.classList.add("open");
}
function renderStatus(text, withSpinner) {
  const list = document.getElementById("suggestionList");
  list.innerHTML = '<div class="status">' + (withSpinner ? '<span class="spinner"></span>' : "") + escapeHtml(text) + '</div>';
  list.classList.add("open");
}
function showSuggestions() { if (lastSuggestions.length) document.getElementById("suggestionList").classList.add("open"); }
function closeSuggestions() { document.getElementById("suggestionList").classList.remove("open"); }
function updateActiveHighlight() {
  document.querySelectorAll("#suggestionList .suggestion").forEach(el => {
    el.classList.toggle("active", parseInt(el.dataset.index) === activeIndex);
  });
  const active = document.querySelector("#suggestionList .suggestion.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}
function onSearchKeydown(e) {
  const isOpen = document.getElementById("suggestionList").classList.contains("open");
  if (e.key === "ArrowDown") {
    if (!lastSuggestions.length) return;
    e.preventDefault();
    if (!isOpen) { showSuggestions(); return; }
    activeIndex = (activeIndex + 1) % lastSuggestions.length;
    updateActiveHighlight();
  } else if (e.key === "ArrowUp") {
    if (!lastSuggestions.length || !isOpen) return;
    e.preventDefault();
    activeIndex = (activeIndex - 1 + lastSuggestions.length) % lastSuggestions.length;
    updateActiveHighlight();
  } else if (e.key === "Tab") {
    if (!lastSuggestions.length || !isOpen) return;
    e.preventDefault();
    if (e.shiftKey) activeIndex = (activeIndex - 1 + lastSuggestions.length) % lastSuggestions.length;
    else activeIndex = (activeIndex + 1) % lastSuggestions.length;
    updateActiveHighlight();
  } else if (e.key === "Enter") {
    if (isOpen && activeIndex >= 0 && lastSuggestions[activeIndex]) { e.preventDefault(); chooseSuggestion(activeIndex); }
    else if (lastSuggestions.length > 0) { e.preventDefault(); chooseSuggestion(0); }
  } else if (e.key === "Escape") {
    closeSuggestions();
  }
}
function chooseSuggestion(i) {
  const album = lastSuggestions[i];
  if (!album) return;
  closeSuggestions();
  document.getElementById("searchInput").value = album.title + " — " + album.artist;
  lastSuggestions = []; activeIndex = -1;
  loadAlbum({ id: album.id, title: album.title, cover: album.cover, source: "spotify" });
}

// ---------- ЗАГРУЗКА АЛЬБОМА ----------
async function loadAlbum(album) {
  const errorBox = document.getElementById("errorBox");
  errorBox.textContent = "Загрузка треков…";
  showFloatingLoader(true);
      // Проверяем, синтетический ли это релиз (оценка трека как сингла)
    if (album.id && String(album.id).startsWith("single_")) {
      // Синтетический сингл — данные уже в объекте album
      currentAlbum = album;
      currentTracks = [{ name: album.title, artist: album.artist, isSkit: false }];
      trackDetails = {}; overallValue = 7; coverRating = 7; singleValues = {};
      errorBox.textContent = "";
      renderAlbum();
      if (currentUser && currentUser.uid === ADMIN_UID) document.getElementById("adminQuickActions").classList.remove("hidden");
      else document.getElementById("adminQuickActions").classList.add("hidden");
      saveDraft();
      showFloatingLoader(false);
      return;
    }
  try {
    const cacheKey = "spotify_" + album.id;
    const cached = cacheGet(LS_RELEASE_CACHE, cacheKey);
    if (cached && cached.songs && cached.songs.length) {
      currentAlbum = cached.album;
      currentTracks = cached.songs;
      trackDetails = {}; overallValue = 7; coverRating = 7; singleValues = {};
      await prefillUserRatingIfExists("spotify", album.id);
      await applyOverride("spotify", album.id);
      errorBox.textContent = "";
      renderAlbum();
      if (currentUser && currentUser.uid === ADMIN_UID) document.getElementById("adminQuickActions").classList.remove("hidden");
      else document.getElementById("adminQuickActions").classList.add("hidden");
      saveDraft();
      showFloatingLoader(false);
      return;
    }

    const data = await spotifyGetAlbum(album.id);
    if (!data || !data.tracks || !data.tracks.items) throw new Error("нет трек-листа");

    const title = data.name || album.title;
    const artist = (data.artists || []).map(x => x.name).join(", ") || "";
    const rawArtwork = (data.images && data.images[0] && data.images[0].url) || "";
    const artwork = rawArtwork
      ? ITUNES_PROXY + "?u=" + encodeURIComponent(rawArtwork)
      : (album.cover || "");
    const songs = data.tracks.items
      .sort((a, b) => (a.track_number || 0) - (b.track_number || 0))
      .map(t => ({ name: t.name, artist: (t.artists || []).map(x => x.name).join(", ") || artist, isSkit: false }))
      .filter(t => t.name);

    if (songs.length === 0) throw new Error("трек-лист пуст");
    if (songs.length > MAX_TRACKS) {
      errorBox.textContent = "В релизе " + songs.length + " треков, взяты первые " + MAX_TRACKS + ".";
      songs.length = MAX_TRACKS;
    } else {
      errorBox.textContent = "";
    }

    currentAlbum = { id: album.id, title, artist, artwork, source: "spotify" };
    currentTracks = songs.map(s => ({ name: s.name, artist: s.artist }));
    trackDetails = {}; overallValue = 7; coverRating = 7; singleValues = {};

    cacheSet(LS_RELEASE_CACHE, cacheKey, { album: currentAlbum, songs: currentTracks });
    await prefillUserRatingIfExists("spotify", album.id);
    await applyOverride("spotify", album.id);
    renderAlbum();
    if (currentUser && currentUser.uid === ADMIN_UID) document.getElementById("adminQuickActions").classList.remove("hidden");
    else document.getElementById("adminQuickActions").classList.add("hidden");
    saveDraft();
    hideWarning();
  } catch (e) {
    errorBox.textContent = "Не удалось загрузить: " + e.message;
    showWarning("🎧 Spotify: " + e.message);
  } finally {
    showFloatingLoader(false);
  }
}
async function applyOverride(source, releaseId) {
  try {
    const key = source + "_" + releaseId;
    const snap = await getDoc(doc(db, "overrides", key));
    if (snap.exists()) {
      const o = snap.data();
      if (o.title) currentAlbum.title = o.title;
      if (o.artist) currentAlbum.artist = o.artist;
      if (o.artwork) currentAlbum.artwork = o.artwork;
      if (o.tracks && o.tracks.length) currentTracks = o.tracks.map(n => ({ name: n, artist: currentAlbum.artist }));
    }
  } catch (e) {}
}
async function prefillUserRatingIfExists(source, releaseId) {
  if (!currentUser) return;
  try {
    const docId = source + "_" + releaseId + "_" + currentUser.uid;
    const snap = await getDoc(doc(db, "ratings", docId));
    if (snap.exists()) {
      const data = snap.data();
      currentAlbum.title = data.album.title || currentAlbum.title;
      currentAlbum.artist = data.album.artist || currentAlbum.artist;
      currentAlbum.artwork = data.album.artwork || currentAlbum.artwork;
      overallValue = data.overall || 7;
      coverRating = data.coverRating || 7;
      trackDetails = data.details || {};
      // Восстанавливаем isSkit
      if (data.skitIndexes && Array.isArray(data.skitIndexes)) {
        data.skitIndexes.forEach(i => {
          if (currentTracks[i]) currentTracks[i].isSkit = true;
        });
      }
      if (currentTracks.length === 1 && data.details && data.details[0]) singleValues = { ...data.details[0] };
      else if (currentTracks.length > 1) currentAlbum._prefillScores = data.scores || null;
      showToast("Загружена ваша предыдущая оценка");
    }
  } catch (e) {}
}

// ---------- РЕНДЕР АЛЬБОМА ----------
function renderAlbum() {
  const parentNote = currentAlbum.isSingleFromAlbum && currentAlbum.parentAlbum
    ? '<div style="font-size:.75rem; color:var(--vibe-1); margin-top:4px;">🎯 Сингл из альбома «' + escapeHtml(currentAlbum.parentAlbum.title) + '»</div>'
    : '';
  document.getElementById("albumCard").innerHTML =
    '<div class="bg-blur" style="background-image:url(\'' + escapeHtml(currentAlbum.artwork) + '\')"></div>' +
    '<img class="cover" src="' + escapeHtml(currentAlbum.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
    '<div class="info"><div class="title">' + escapeHtml(currentAlbum.title) + '</div><div class="artist">' + escapeHtml(currentAlbum.artist) + '</div>' + parentNote + '</div>';
  const isSingle = currentTracks.length === 1;
  const tracksSection = document.getElementById("tracksSection");
  const singleSection = document.getElementById("singleSection");
  if (isSingle) {
    tracksSection.classList.add("hidden");
    singleSection.classList.remove("hidden");
    renderSingleCriteria();
    renderOverall(singleValues[VIBE_KEY] != null ? singleValues[VIBE_KEY] : 7);
  } else {
    tracksSection.classList.remove("hidden");
    singleSection.classList.add("hidden");
    const prefill = currentAlbum._prefillScores;
    const initialScores = prefill && prefill.length === currentTracks.length ? prefill : currentTracks.map(() => 7);
    renderTracks(initialScores);
    renderOverall(overallValue);
  }
  document.getElementById("step1").classList.add("hidden");
  document.getElementById("step2").classList.remove("hidden");
  document.getElementById("coverRating").value = coverRating;
  document.getElementById("coverRatingVal").textContent = coverRating;
  updateSliderFill(document.getElementById("coverRating"));
  updateCoverBadge();
  updateScore();
  updateCompareLine();
}
function renderSingleCriteria() {
  const wrap = document.getElementById("singleCriteriaList");
  wrap.innerHTML = "";
  MAIN_CRITERIA.forEach(c => { if (singleValues[c.key] == null) singleValues[c.key] = 7; });
  MAIN_CRITERIA.forEach(c => {
    const block = document.createElement("div");
    block.className = "criterion single-criterion";
    const head = document.createElement("div");
    head.className = "criterion-head";
    head.innerHTML = '<div class="criterion-name"><span class="criterion-emoji">' + c.emoji + '</span><span>' + c.name + '</span></div>' +
      '<div class="criterion-val" data-key="' + c.key + '">' + singleValues[c.key] + '</div>';
    block.appendChild(head);
    const controls = document.createElement("div");
    controls.className = "criterion-controls";
    controls.appendChild(buildCriterionControl(c.key, singleValues[c.key], (val) => {
      singleValues[c.key] = val;
      head.querySelector(".criterion-val").textContent = val;
      updateScore(); saveDraft();
    }));
    block.appendChild(controls);
    wrap.appendChild(block);
  });
  updateScore();
}
function buildCriterionControl(key, value, onChange) {
  if (ratingMode === "stars") {
    const stars = document.createElement("div");
    stars.className = "stars";
    let current = value;
    for (let s = 1; s <= 10; s++) {
      const star = document.createElement("button");
      star.type = "button";
      star.className = "star" + (s <= value ? " on" : "");
      star.textContent = "★";
      star.dataset.value = s;
      star.onmouseenter = () => previewStars(stars, s);
      star.onmouseleave = () => previewStars(stars, current);
      star.onclick = () => {
        current = s;
        previewStars(stars, s);
        stars.querySelectorAll(".star").forEach((el, idx) => {
          if (idx < s) { el.classList.remove("fire"); void el.offsetWidth; el.classList.add("fire"); setTimeout(() => el.classList.remove("fire"), 500); }
        });
        onChange(s);
      };
      stars.appendChild(star);
    }
    return stars;
  }
  const slider = document.createElement("input");
  slider.type = "range"; slider.min = 1; slider.max = 10; slider.step = 1; slider.value = value;
  updateSliderFill(slider);
  slider.oninput = () => { updateSliderFill(slider); onChange(parseInt(slider.value)); };
  return slider;
}
function renderTracks(values) {
  const list = document.getElementById("tracksList");
  list.innerHTML = "";
  currentTracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "track-row" + (t.isSkit ? " is-skit" : "");
    row.dataset.index = i;
    row.dataset.value = values[i] != null ? values[i] : 7;
    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "track-name";
    nameBtn.title = "Открыть подробную оценку";
    const detailBadge = trackDetails[i] ? '<span class="detail-badge">детально</span>' : "";
    const skitBadge = t.isSkit ? '<span class="skit-badge">🎙 скит</span>' : "";
    nameBtn.innerHTML = '<span class="track-num">' + (i + 1) + '.</span><span>' + escapeHtml(t.name) + '</span>' + detailBadge + skitBadge;
    nameBtn.onclick = () => openModal(i);
    row.appendChild(nameBtn);
    const control = document.createElement("div");
    control.className = "control";
    row.appendChild(control);
    const val = document.createElement("div");
    val.className = "range-val";
    row.appendChild(val);
    if (ratingMode === "stars") control.appendChild(buildStars(row, parseInt(row.dataset.value)));
    else control.appendChild(buildSlider(row, parseInt(row.dataset.value)));
    val.textContent = row.dataset.value;
    // Кнопка "скит"
    const skitBtn = document.createElement("button");
    skitBtn.type = "button";
    skitBtn.className = "skit-btn" + (t.isSkit ? " active" : "");
    skitBtn.title = t.isSkit ? "Убрать из скитов" : "Пометить как скит (не учитывается в итоге)";
    skitBtn.innerHTML = "🎙";
    skitBtn.onclick = (ev) => {
      ev.stopPropagation();
      toggleSkit(i);
    };
    row.appendChild(skitBtn);
    list.appendChild(row);
  });
}
// Переключить трек в режим "скит"
function toggleSkit(index) {
  const track = currentTracks[index];
  if (!track) return;
  track.isSkit = !track.isSkit;
  // Обновляем визуально конкретную строку
  const row = document.querySelector('#tracksList .track-row[data-index="' + index + '"]');
  if (row) {
    row.classList.toggle("is-skit", track.isSkit);
    const btn = row.querySelector(".skit-btn");
    if (btn) {
      btn.classList.toggle("active", track.isSkit);
      btn.title = track.isSkit ? "Убрать из скитов" : "Пометить как скит (не учитывается в итоге)";
    }
    // Бейдж
    const nameBtn = row.querySelector(".track-name");
    if (nameBtn) {
      const existingBadge = nameBtn.querySelector(".skit-badge");
      if (track.isSkit && !existingBadge) {
        const badge = document.createElement("span");
        badge.className = "skit-badge";
        badge.textContent = "🎙 скит";
        nameBtn.appendChild(badge);
      } else if (!track.isSkit && existingBadge) {
        existingBadge.remove();
      }
    }
  }
  updateScore();
  saveDraft();
}
function buildSlider(row, value) {
  const slider = document.createElement("input");
  slider.type = "range"; slider.min = 1; slider.max = 10; slider.value = value; slider.step = 1;
  updateSliderFill(slider);
  slider.oninput = () => {
    row.dataset.value = slider.value;
    row.querySelector(".range-val").textContent = slider.value;
    updateSliderFill(slider);
    updateScore(); saveDraft();
  };
  return slider;
}
function buildStars(row, value) {
  const wrap = document.createElement("div");
  wrap.className = "stars";
  for (let s = 1; s <= 10; s++) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = "star" + (s <= value ? " on" : "");
    star.textContent = "★";
    star.dataset.value = s;
    star.onmouseenter = () => previewStars(wrap, s);
    star.onmouseleave = () => previewStars(wrap, parseInt(row.dataset.value));
    star.onclick = () => {
      row.dataset.value = s;
      row.querySelector(".range-val").textContent = s;
      previewStars(wrap, s);
      wrap.querySelectorAll(".star").forEach((el, idx) => {
        if (idx < s) { el.classList.remove("fire"); void el.offsetWidth; el.classList.add("fire"); setTimeout(() => el.classList.remove("fire"), 500); }
      });
      updateScore(); saveDraft();
    };
    wrap.appendChild(star);
  }
  return wrap;
}
function previewStars(wrap, upto) {
  wrap.querySelectorAll(".star").forEach(s => { s.classList.toggle("on", parseInt(s.dataset.value) <= upto); });
}
function updateSliderFill(slider) {
  const min = +slider.min, max = +slider.max, val = +slider.value;
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = "linear-gradient(90deg, var(--accent) 0%, var(--accent-3) " + pct + "%, var(--border) " + pct + "%, var(--border) 100%)";
}
function getRowValue(row) { return parseInt(row.dataset.value) || 7; }
function setRatingMode(mode) {
  ratingMode = mode;
  localStorage.setItem(LS_MODE, mode);
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  if (currentTracks.length === 1) renderSingleCriteria();
  else if (currentTracks.length > 1) {
    const scores = [];
    document.querySelectorAll("#tracksList .track-row").forEach(r => scores.push(getRowValue(r)));
    renderTracks(scores);
  }
  renderOverall(currentTracks.length === 1 ? (singleValues[VIBE_KEY] || 7) : overallValue);
  updateScore();
}
function initRatingMode() {
  ratingMode = localStorage.getItem(LS_MODE) || "slider";
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === ratingMode));
}
function renderOverall(value) {
  if (currentTracks.length === 1) singleValues[VIBE_KEY] = value;
  else overallValue = value;
  const wrap = document.getElementById("overallRow");
  if (!wrap) return;
  wrap.innerHTML = "";
  const control = document.createElement("div");
  control.className = "control";
  wrap.appendChild(control);
  const getCurrent = () => currentTracks.length === 1 ? (singleValues[VIBE_KEY] || 7) : overallValue;
  if (ratingMode === "stars") {
    const stars = document.createElement("div");
    stars.className = "stars";
    for (let s = 1; s <= 10; s++) {
      const star = document.createElement("button");
      star.type = "button";
      star.className = "star" + (s <= value ? " on" : "");
      star.textContent = "★";
      star.dataset.value = s;
      star.onmouseenter = () => previewStars(stars, s);
      star.onmouseleave = () => previewStars(stars, getCurrent());
      star.onclick = () => {
        if (currentTracks.length === 1) singleValues[VIBE_KEY] = s;
        else overallValue = s;
        previewStars(stars, s);
        document.getElementById("overallBadge").textContent = s + " / 10";
        updateScore(); saveDraft();
      };
      stars.appendChild(star);
    }
    control.appendChild(stars);
  } else {
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = 1; slider.max = 10; slider.value = value; slider.step = 1;
    updateSliderFill(slider);
    slider.oninput = () => {
      const v = parseInt(slider.value);
      if (currentTracks.length === 1) singleValues[VIBE_KEY] = v;
      else overallValue = v;
      document.getElementById("overallBadge").textContent = v + " / 10";
      updateSliderFill(slider);
      updateScore(); saveDraft();
    };
    control.appendChild(slider);
  }
  document.getElementById("overallBadge").textContent = value + " / 10";
  const autoBtn = document.createElement("button");
  autoBtn.className = "btn-secondary auto-btn";
  autoBtn.textContent = "= средняя";
  autoBtn.onclick = setOverallToAvg;
  wrap.appendChild(autoBtn);
}
function setOverallToAvg() {
  let avg;
  if (currentTracks.length === 1) {
    let sum = 0;
    MAIN_CRITERIA.forEach(c => { sum += singleValues[c.key] || 7; });
    avg = Math.round(sum / MAIN_CRITERIA.length);
  } else {
    const rows = document.querySelectorAll("#tracksList .track-row");
    if (!rows.length) return;
    let sum = 0;
    rows.forEach(r => { sum += getRowValue(r); });
    avg = Math.round(sum / rows.length);
  }
  renderOverall(avg);
  updateScore(); saveDraft();
  showToast("Впечатление = " + avg);
}
function onCoverRatingChange(v) {
  coverRating = parseInt(v);
  document.getElementById("coverRatingVal").textContent = v;
  updateSliderFill(document.getElementById("coverRating"));
  updateCoverBadge();
  saveDraft();
}
function updateCoverBadge() {
  const el = document.getElementById("coverBadge");
  if (!el) return;
  const v = coverRating;
  el.className = "cover-badge";
  let tierClass, note;
  if (v >= 10) { tierClass = "tier-perfect"; note = "Идеальная обложка ✨"; }
  else if (v >= 8) { tierClass = "tier-good"; note = "Отличный визуал"; }
  else if (v >= 5) { tierClass = "tier-mid"; note = "Обычная обложка"; }
  else { tierClass = "tier-poor"; note = "Слабое оформление"; }
  el.classList.add(tierClass);
  el.innerHTML = '<span class="badge-label">🎨 Обложка</span>' +
    '<span class="badge-score">' + v + ' / 10</span>' +
    '<span class="badge-note">' + note + '</span>';
  el.classList.remove("hidden");
}
function updateScore() {
  let final, avg, overall, scores;
  if (currentTracks.length === 1) {
    const vibe = singleValues[VIBE_KEY] || 7;
    const { avgMain, singleScore } = computeSingleScore(singleValues);
    final = computeFinalScore([singleScore], vibe);
    avg = avgMain; overall = vibe; scores = [singleScore];
  } else {
    const rows = document.querySelectorAll("#tracksList .track-row");
    if (rows.length === 0) return;
    // Все оценки (включая скиты)
    const allScores = [];
    rows.forEach(r => allScores.push(getRowValue(r)));
    // Только не-скиты — идут в расчёт
    const nonSkitScores = [];
    currentTracks.forEach((t, i) => {
      if (!t.isSkit) nonSkitScores.push(allScores[i]);
    });
    if (nonSkitScores.length === 0) {
      // Все треки — скиты: возвращаем "недоступно"
      document.getElementById("finalScore").textContent = "—";
      document.getElementById("verdict").textContent = "Отметьте хотя бы один трек, который не скит";
      const rateBtn = document.getElementById("rateBtn");
      if (rateBtn) rateBtn.disabled = true;
      return;
    }
    const sum = nonSkitScores.reduce((a, b) => a + b, 0);
    avg = sum / nonSkitScores.length;
    overall = overallValue;
    final = computeFinalScore(nonSkitScores, overall);
    scores = nonSkitScores;
  }
  // Разблокируем кнопку, если треки есть
  const rateBtn2 = document.getElementById("rateBtn");
  if (rateBtn2) rateBtn2.disabled = false;
  const tier = getTier(final);
  const resultBox = document.getElementById("resultBox");
  TIERS.forEach(t => resultBox.classList.remove(t.cssClass));
  resultBox.classList.add(tier.cssClass);
  const tierEmojiEl = document.getElementById("tierEmoji");
  tierEmojiEl.className = "tier-medal " + tier.medal;
  tierEmojiEl.textContent = tier.emoji;
  tierEmojiEl.title = tier.name;
  document.getElementById("tierName").textContent = tier.name;
  document.getElementById("tierRow").style.color = tier.color;
  document.getElementById("finalScore").textContent = final;
  const verdictMap = currentTracks.length === 1 ? VERDICTS_SINGLE : VERDICTS_ALBUM;
  document.getElementById("verdict").textContent = verdictMap[tier.name] || "";
  const nextTier = getNextTier(final);
  const progEl = document.getElementById("tierProgress");
  if (nextTier) {
    const minNeeded = Math.round(nextTier.min * FINAL_MAX);
    const diff = minNeeded - final;
    const curMin = Math.round(tier.min * FINAL_MAX);
    const span = Math.max(1, minNeeded - curMin);
    const pct = Math.max(0, Math.min(100, ((final - curMin) / span) * 100));
    progEl.innerHTML = 'До <b style="color:' + nextTier.color + '">' + nextTier.emoji + ' ' + nextTier.name + '</b>: +' + diff + ' · след. тир на ' + minNeeded +
      '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>';
  } else progEl.innerHTML = "🌟 Максимум достигнут";
  if (currentTracks.length === 1) {
    const vibeFactor = 0.5 + (overall / 10) * 0.5;
    document.getElementById("details").innerHTML =
      'Сингл · среднее по 4 критериям: <b>' + avg.toFixed(2) + '</b> / 10<br>' +
      'Атмосфера / вайб: <b>' + overall + '</b> / 10 · Множитель: <b>×' + vibeFactor.toFixed(2) + '</b><br>' +
      '<span style="opacity:.7">' + avg.toFixed(2) + ' × 36 × ' + vibeFactor.toFixed(2) + ' = <b>' + final + '</b></span>';
  } else {
    const vibeFactor = 0.5 + (overall / 10) * 0.5;
    document.getElementById("details").innerHTML =
      'Средняя по трекам (без скитов): <b>' + avg.toFixed(2) + '</b> / 10<br>' +
      'Атмосфера / вайб: <b>' + overall + '</b> / 10 · Множитель: <b>×' + vibeFactor.toFixed(2) + '</b><br>' +
      '<span style="opacity:.7">' + avg.toFixed(2) + ' × 36 × ' + vibeFactor.toFixed(2) + ' = <b>' + final + '</b></span>';
  }
  const ring = document.getElementById("ringFg");
  const C = 2 * Math.PI * 50;
  const pct = Math.max(0, Math.min(1, final / FINAL_MAX));
  ring.setAttribute("stroke-dashoffset", C * (1 - pct));
  lastFinalScore = final;
  renderHistogram(scores);
}
function renderHistogram(scores) {
  const barsEl = document.getElementById("histBars");
  const summaryEl = document.getElementById("histSummary");
  const counts = Array(11).fill(0);
  scores.forEach(v => { if (v >= 1 && v <= 10) counts[Math.min(10, Math.max(1, Math.round(v)))]++; });
  const maxCount = Math.max(...counts.slice(1), 1);
  barsEl.innerHTML = "";
  for (let i = 1; i <= 10; i++) {
    const c = counts[i];
    const col = document.createElement("div");
    col.className = "hist-col";
    const wrap = document.createElement("div");
    wrap.className = "hist-bar-wrap";
    const bar = document.createElement("div");
    bar.className = "hist-bar" + (c === 0 ? " empty" : "");
    const h = c === 0 ? 3 : Math.max(6, (c / maxCount) * 48);
    bar.style.height = h + "px";
    bar.title = c > 0 ? c + " трек(ов) на " + i : "нет треков на " + i;
    wrap.appendChild(bar); col.appendChild(wrap);
    const lbl = document.createElement("div");
    lbl.className = "hist-label"; lbl.textContent = i;
    col.appendChild(lbl);
    barsEl.appendChild(col);
  }
  const box = document.getElementById("histogramBox");
  if (scores.length > 10 && currentTracks.length > 10) {
    if (!box.dataset.userToggled) box.classList.add("collapsed");
  }
  const n = scores.length;
  if (n === 0) { summaryEl.textContent = ""; return; }
  const min = Math.min(...scores), max = Math.max(...scores);
  const tens = counts[10];
  const low = counts[1] + counts[2] + counts[3];
  const range = max - min;
  let balance = range <= 2 ? "ровный по силе" : range >= 5 ? "контрастный" : "умеренно ровный";
  if (n === 1 && currentTracks.length === 1) {
    summaryEl.innerHTML = 'Сингл · среднее по 4 критериям: <b>' + scores[0] + '</b> / 10';
  } else {
    summaryEl.innerHTML = plural(n, "Трек", "Трека", "Треков") + ': <b>' + n + '</b> · разброс: <b>' + min + '–' + max + '</b> (' + balance + ')' +
      (tens > 0 ? ' · на 10: <b>' + tens + '</b>' : "") +
      (low > 0 ? ' · слабых (1–3): <b>' + low + '</b>' : "");
  }
}
function toggleHistogram() {
  const box = document.getElementById("histogramBox");
  box.classList.toggle("collapsed");
  box.dataset.userToggled = "1";
}
async function updateCompareLine() {
  const el = document.getElementById("compareLine");
  if (!el || !currentAlbum) { if (el) el.classList.add("hidden"); return; }
  try {
    const snap = await getDocs(collection(db, "ratings"));
    const all = snap.docs.map(d => d.data()).filter(r => !r.hidden);
    const same = all.filter(r => r.releaseId === String(currentAlbum.id) && r.source === currentAlbum.source);
    if (same.length < 2) { el.classList.add("hidden"); return; }
    const avg = Math.round(same.reduce((a, r) => a + r.final, 0) / same.length);
    const my = lastFinalScore || 0;
    const delta = my - avg;
    let deltaClass = "neutral", deltaText = "= как у всех";
    if (delta > 0) { deltaClass = "plus"; deltaText = "+" + delta + " к среднему"; }
    else if (delta < 0) { deltaClass = "minus"; deltaText = delta + " к среднему"; }
    el.innerHTML = '<span>Вы: <b>' + my + '</b></span><span>Средняя: <b>' + avg + '</b></span><span class="delta ' + deltaClass + '">' + deltaText + '</span>';
    el.classList.remove("hidden");
  } catch (e) { el.classList.add("hidden"); }
}

// ---------- МОДАЛКА ТРЕКА ----------
function openModal(index) {
  const track = currentTracks[index];
  if (!track) return;
  modalTrackIndex = index;
  document.getElementById("modalCover").src = currentAlbum.artwork || "";
  document.getElementById("modalCover").onerror = function() { this.style.visibility = "hidden"; };
  document.getElementById("modalTitle").textContent = (index + 1) + ". " + track.name;
  document.getElementById("modalArtist").textContent = track.artist || "";
  const stored = trackDetails[index];
  modalValues = {};
  TRACK_CRITERIA.forEach(c => { modalValues[c.key] = stored ? stored[c.key] : 7; });
  renderCriteria();
  document.getElementById("modalBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeModal() {
  document.getElementById("modalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
  modalTrackIndex = -1;
}
function toggleHelp() { document.getElementById("helpBox").classList.toggle("hidden"); }
function toggleHelpSingle() { document.getElementById("singleHelpBox").classList.toggle("hidden"); }
function renderCriteria() {
  const wrap = document.getElementById("criteriaList");
  wrap.innerHTML = "";
  TRACK_CRITERIA.forEach(c => {
    const isVibe = c.key === VIBE_KEY;
    const block = document.createElement("div");
    block.className = "criterion" + (isVibe ? " vibe-criterion" : "");
    const head = document.createElement("div");
    head.className = "criterion-head";
    const multBadge = isVibe ? '<span class="mult-badge">×Множитель</span>' : "";
    head.innerHTML = '<div class="criterion-name"><span class="criterion-emoji">' + c.emoji + '</span><span>' + c.name + multBadge + '</span></div>' +
      '<div class="criterion-val" data-key="' + c.key + '">' + modalValues[c.key] + '</div>';
    block.appendChild(head);
    const controls = document.createElement("div");
    controls.className = "criterion-controls";
    controls.appendChild(buildCriterionControl(c.key, modalValues[c.key], (val) => {
      modalValues[c.key] = val;
      updateCriterionVal(c.key, val);
      updateModalTotal();
    }));
    block.appendChild(controls);
    wrap.appendChild(block);
  });
  updateModalTotal();
}
function updateCriterionVal(key, value) {
  const el = document.querySelector('.criterion-val[data-key="' + key + '"]');
  if (el) el.textContent = value;
}
function calcTrackRating() {
  let sum = 0;
  MAIN_CRITERIA.forEach(c => { sum += modalValues[c.key]; });
  const avg = sum / MAIN_CRITERIA.length;
  const vibe = modalValues[VIBE_KEY] || 10;
  const raw = avg * vibe / 10;
  const rounded = Math.max(1, Math.min(10, Math.round(raw)));
  return { avg, vibe, raw, rounded };
}
function updateModalTotal() {
  const { avg, vibe, rounded } = calcTrackRating();
  const totalEl = document.getElementById("modalTotal");
  const hintEl = document.getElementById("modalHint");
  totalEl.textContent = rounded;
  totalEl.classList.toggle("max", rounded >= 10);
  const tier = getTier(Math.round(rounded / 10 * 360));
  const verdict = VERDICTS_TRACK[tier.name] || "";
  hintEl.innerHTML = "из 10 · <b>" + verdict + "</b><br><span style=\"opacity:.7\">(среднее " + avg.toFixed(2) + " × " + vibe + "/10)</span>";
}
// Оценить трек как отдельный сингл
function rateTrackAsSingle() {
  const idx = modalTrackIndex;
  if (idx < 0 || !currentAlbum) return;
  const track = currentTracks[idx];
  if (!track) return;

  // Создаём синтетический релиз с одним треком
  const syntheticId = "single_" + currentAlbum.source + "_" + currentAlbum.id + "_" + idx;
  const syntheticAlbum = {
    id: syntheticId,
    title: track.name,
    artist: track.artist || currentAlbum.artist,
    artwork: currentAlbum.artwork,
    source: currentAlbum.source,
    parentAlbum: {
      id: currentAlbum.id,
      title: currentAlbum.title,
      artist: currentAlbum.artist
    },
    isSingleFromAlbum: true,
    trackIndex: idx
  };
  const syntheticTracks = [{ name: track.name, artist: track.artist || currentAlbum.artist, isSkit: false }];

  // Закрываем модалку трека
  closeModal();

  // Загружаем синтетический релиз (минуя API — данные уже есть)
  currentAlbum = syntheticAlbum;
  currentTracks = syntheticTracks;
  trackDetails = {};
  singleValues = {};
  overallValue = 7;
  coverRating = 7;

  // Обновляем UI
  document.getElementById("step1").classList.add("hidden");
  document.getElementById("step2").classList.remove("hidden");
  renderAlbum();
  if (currentUser && currentUser.uid === ADMIN_UID) document.getElementById("adminQuickActions").classList.remove("hidden");
  else document.getElementById("adminQuickActions").classList.add("hidden");
  saveDraft();

  showToast("Сингл загружен — оцените его по 4 критериям + вайб", { gold: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function applyModalRating() {
  const idx = modalTrackIndex;
  if (idx < 0) return;
  const { rounded } = calcTrackRating();
  trackDetails[idx] = { ...modalValues };
  const row = document.querySelector('#tracksList .track-row[data-index="' + idx + '"]');
  if (row) {
    row.dataset.value = rounded;
    row.querySelector(".range-val").textContent = rounded;
    const control = row.querySelector(".control");
    control.innerHTML = "";
    if (ratingMode === "stars") control.appendChild(buildStars(row, rounded));
    else control.appendChild(buildSlider(row, rounded));
    const nameBtn = row.querySelector(".track-name");
    if (nameBtn && !nameBtn.querySelector(".detail-badge")) {
      const badge = document.createElement("span");
      badge.className = "detail-badge";
      badge.textContent = "детально";
      nameBtn.appendChild(badge);
    }
  }
  updateScore(); saveDraft();
  closeModal();
  showToast("Оценка трека: " + rounded);
}

// ---------- SUBMIT RATING ----------
async function submitRating() {
  if (!currentUser) { showToast("Нужно войти"); return; }
  if (!currentAlbum) return;
  const rl = rateLimitCheck();
  if (!rl.ok) { showToast(rl.reason); return; }
  const isSingle = currentTracks.length === 1;
  let scores, avg, overall, final;
  if (isSingle) {
    const vibe = singleValues[VIBE_KEY] || 7;
    const { avgMain, singleScore } = computeSingleScore(singleValues);
    final = computeFinalScore([singleScore], vibe);
    avg = avgMain; overall = vibe; scores = [singleScore];
    trackDetails[0] = { ...singleValues };
  } else {
    const rows = document.querySelectorAll("#tracksList .track-row");
    if (!rows.length) return;
    scores = [];    // ← сюда ВСЕ оценки
    rows.forEach(r => scores.push(getRowValue(r)));
    // Для расчёта — только не-скиты
    const nonSkitScores = [];
    currentTracks.forEach((t, i) => {
      if (!t.isSkit) nonSkitScores.push(scores[i]);
    });
    if (nonSkitScores.length === 0) {
      showToast("Отметьте хотя бы один трек, который не скит");
      return;
    }
    const sum = nonSkitScores.reduce((a, b) => a + b, 0);
    avg = sum / nonSkitScores.length;
    overall = overallValue;
    final = computeFinalScore(nonSkitScores, overall);
  }
  const btn = document.getElementById("rateBtn");
  btn.disabled = true;
  try {
    const docId = currentAlbum.source + "_" + currentAlbum.id + "_" + currentUser.uid;
    const previousSnap = await getDoc(doc(db, "ratings", docId));
    const isNew = !previousSnap.exists();
    let history = [];
    if (previousSnap.exists()) {
      const prev = previousSnap.data();
      history = prev.history || [];
      if (prev.final !== final) {
        history.push({
          oldFinal: prev.final,
          newFinal: final,
          ts: Math.floor(Date.now() / 1000)
        });
        if (history.length > 20) history.shift();
      }
    }
    const skitIndexes = [];
    currentTracks.forEach((t, i) => { if (t.isSkit) skitIndexes.push(i); });
    await setDoc(doc(db, "ratings", docId), {
      uid: currentUser.uid,
      nickname: userProfile.nickname,
      avatar: userProfile.avatar || "🎵",
      level: getLevelByXp(userProfile.xp || 0).level,
      releaseId: String(currentAlbum.id),
      source: currentAlbum.source,
      album: {
        id: currentAlbum.id, title: currentAlbum.title,
        artist: currentAlbum.artist, artwork: currentAlbum.artwork,
        source: currentAlbum.source,
        parentAlbum: currentAlbum.parentAlbum || null,
        isSingleFromAlbum: currentAlbum.isSingleFromAlbum || false,
        tracks: currentTracks.map(t => ({ name: t.name, artist: t.artist, isSkit: !!t.isSkit }))
      },
      scores, overall, coverRating,
      skitIndexes,
      details: trackDetails,
      avg: +avg.toFixed(2),
      final, isSingle,
      history,
      ts: serverTimestamp()
    });
    const wrap = document.getElementById("ringWrap");
    wrap.classList.remove("spin"); void wrap.offsetWidth; wrap.classList.add("spin");
    setTimeout(() => wrap.classList.remove("spin"), 950);
    const savedBadge = document.getElementById("savedBadge");
    savedBadge.classList.add("show");
    setTimeout(() => savedBadge.classList.remove("show"), 2000);
    await removeFromWishlistIfExists(currentAlbum.source, currentAlbum.id);
    if (isNew) {
      await addXp(XP_REWARDS.rating, "Оценка релиза");
      const hour = new Date().getHours();
      if (hour >= 0 && hour < 6 && !userAchievements.has("night")) userAchievements.add("night");
      if (hour >= 6 && hour < 9 && !userAchievements.has("early")) userAchievements.add("early");
      if (hour >= 5 && hour < 7 && !userAchievements.has("dawn")) userAchievements.add("dawn");
      if (hour >= 20 && hour < 23 && !userAchievements.has("evening")) userAchievements.add("evening");
      const detailedCount = Object.keys(trackDetails).length;
      if (detailedCount > 0) await addXp(detailedCount * XP_REWARDS.detailedTrack, "Подробная оценка треков");
    }
    rateLimitRegister();
    // Лента — пишем activity
    await pushActivity({
      type: "rating",
      uid: currentUser.uid,
      nickname: userProfile.nickname,
      avatar: userProfile.avatar || "🎵",
      releaseId: String(currentAlbum.id),
      releaseTitle: currentAlbum.title,
      releaseArtwork: currentAlbum.artwork,
      releaseArtist: currentAlbum.artist,
      source: currentAlbum.source,
      final: final,
      tierName: getTier(final).name,
      tierEmoji: getTier(final).emoji
    });
    clearDraft();
    ratingsThisSession++;
    showToast("Оценка сохранена: " + final, { success: true });
    await loadMyRatings();
    updateUserRatingCount();
    await checkAchievements();
    updateCompareLine();
  } catch (e) {
    showToast("Ошибка сохранения: " + e.message);
  } finally { btn.disabled = false; }
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

// ---------- ЛЕНТА АКТИВНОСТИ ----------
async function pushActivity(data) {
  try {
    await addDoc(collection(db, "activity"), {
      ...data,
      ts: serverTimestamp()
    });
  } catch (e) { console.warn("Не удалось записать activity:", e.message); }
}
function subscribeFeed() {
  if (_feedUnsub) _feedUnsub();
  try {
    const q = query(
      collection(db, "activity"),
      orderBy("ts", "desc"),
      fbLimit(FEED_MAX_ITEMS)
    );
    _feedUnsub = onSnapshot(q, (snap) => {
      feedData = snap.docs.map(d => {
        const data = d.data();
        return { _id: d.id, ...data, _tsSec: data.ts?.seconds || 0 };
      });
      renderFeed();
      renderHotToday();
    }, (err) => {
      console.warn("Feed subscribe error:", err.message);
      feedData = [];
      renderFeed();
      renderHotToday();
    });
  } catch (e) {}
}
async function refreshFeed() {
  subscribeFeed();
  renderHotToday();
  showToast("Обновлено");
}
async function renderHotToday() {
  const gridEl = document.getElementById("hotGrid");
  if (!gridEl) return;
  gridEl.innerHTML = '<div class="empty-msg" style="padding:14px;"><span class="spinner"></span></div>';
  try {
    const snap = await getDocs(collection(db, "ratings"));
    const all = snap.docs.map(d => d.data()).filter(r => !r.hidden);
    const dayAgo = (Date.now() / 1000) - 86400;
    const recent = all.filter(r => (r.ts?.seconds || 0) >= dayAgo);

    // Группируем по релизам
    const groups = {};
    recent.forEach(r => {
      const key = r.source + "_" + r.releaseId;
      if (!groups[key]) groups[key] = {
        album: r.album, source: r.source, releaseId: r.releaseId,
        ratings: [], comments: 0
      };
      groups[key].ratings.push(r.final);
    });

    // Загружаем количество комментариев за сутки
    try {
      const cSnap = await getDocs(collection(db, "comments"));
      cSnap.docs.forEach(d => {
        const c = d.data();
        if ((c.ts?.seconds || 0) < dayAgo) return;
        const key = c.source + "_" + c.releaseId;
        if (groups[key]) groups[key].comments++;
      });
    } catch (e) {}

    const list = Object.values(groups).map(g => ({
      ...g,
      avg: Math.round(g.ratings.reduce((a, b) => a + b, 0) / g.ratings.length),
      count: g.ratings.length
    }));

    // Топ-3 по средней
    const topByScore = [...list].sort((a, b) => b.avg - a.avg || b.count - a.count).slice(0, 3);
    // Топ-3 по обсуждению
    const topByComments = [...list].sort((a, b) => b.comments - a.comments || b.count - a.count).slice(0, 3);

    if (list.length === 0) {
      gridEl.innerHTML = '<div class="empty-msg">Сегодня ещё ничего не оценивали.<br>Будьте первым!</div>';
      return;
    }

    const buildCol = (title, items, valueField) => {
      let html = '<div class="hot-col"><div class="hot-col-title">' + title + '</div>';
      if (items.length === 0) {
        html += '<div class="hot-empty">Пусто</div>';
      } else {
        items.forEach((it, i) => {
          const tier = getTier(it.avg || 0);
          const val = valueField === "comments" ? (it.comments + ' 💬') : it.avg;
          const color = valueField === "comments" ? "var(--accent-3)" : tier.color;
          html += '<div class="hot-item" data-source="' + escapeHtml(it.source) + '" data-release-id="' + escapeHtml(String(it.releaseId)) + '">' +
            '<div class="hot-rank">' + (i + 1) + '</div>' +
            (it.album && it.album.artwork ? '<img src="' + escapeHtml(it.album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '<div class="hot-noart">💿</div>') +
            '<div class="hot-info">' +
              '<div class="hot-title">' + escapeHtml(it.album.title || "") + '</div>' +
              '<div class="hot-artist">' + escapeHtml(it.album.artist || "") + '</div>' +
            '</div>' +
            '<div class="hot-score" style="color:' + color + '">' + val + '</div>' +
          '</div>';
        });
      }
      html += '</div>';
      return html;
    };

    gridEl.innerHTML =
      buildCol("🏆 Лучшие по средней", topByScore, "avg") +
      buildCol("💬 Самые обсуждаемые", topByComments, "comments");

    // Клики
    gridEl.querySelectorAll(".hot-item").forEach(el => {
      el.onclick = () => {
        const src = el.dataset.source;
        const rid = el.dataset.releaseId;
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
    gridEl.innerHTML = '<div class="empty-msg" style="color:var(--danger)">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}
function switchFeedTab(tab) {
  currentFeedTab = tab;
  document.querySelectorAll(".feed-tab").forEach(t => t.classList.toggle("active", t.dataset.feed === tab));
  feedRendered = 0;
  feedAllLoaded = false;
  renderFeed();
}
function renderFeed() {
  const listEl = document.getElementById("feedList");
  if (!listEl) return;

  // Берём только последние 24 часа
  const dayAgo = (Date.now() / 1000) - 86400;
  let recent = feedData.filter(item => (item._tsSec || 0) >= dayAgo);

  // Убираем достижения — они не интересны другим
  recent = recent.filter(item => item.type !== "achievement");

  // Схлопываем оценки одного юзера, поставленные подряд (в течение 30 минут)
  const collapsed = collapseRatings(recent);

  // Ограничиваем 8 записями
  const shown = collapsed.slice(0, 8);

  listEl.innerHTML = "";
  if (shown.length === 0) {
    listEl.innerHTML = '<div class="empty-msg">Пока ничего не произошло.<br>Будьте первым!</div>';
    return;
  }

  shown.forEach(item => {
    listEl.appendChild(buildMiniFeedItem(item));
  });
}

// Схлопывание: если юзер поставил несколько оценок подряд — объединяем
function collapseRatings(items) {
  const result = [];
  let i = 0;
  while (i < items.length) {
    const current = items[i];
    if (current.type !== "rating") {
      result.push(current);
      i++;
      continue;
    }
    // Собираем все оценки этого юзера подряд
    const group = [current];
    let j = i + 1;
    while (j < items.length &&
           items[j].type === "rating" &&
           items[j].uid === current.uid &&
           (current._tsSec - items[j]._tsSec) < 1800) {
      group.push(items[j]);
      j++;
    }
    if (group.length === 1) {
      result.push(current);
    } else {
      result.push({
        ...current,
        _collapsed: true,
        _count: group.length,
        _items: group
      });
    }
    i = j;
  }
  return result;
}
function appendFeedChunk() {
  const listEl = document.getElementById("feedList");
  const end = Math.min(feedRendered + FEED_PAGE_SIZE, feedItems.length);
  const chunk = feedItems.slice(feedRendered, end);
  chunk.forEach(item => {
    listEl.appendChild(buildFeedItem(item));
  });
  feedRendered = end;
  // Убираем старый sentinel
  const oldSentinel = document.getElementById("feedSentinel");
  if (oldSentinel) oldSentinel.remove();
  if (feedRendered < feedItems.length) {
    const sentinel = document.createElement("div");
    sentinel.id = "feedSentinel";
    sentinel.style.cssText = "padding:20px; text-align:center; color:var(--text-dim); font-size:.85rem;";
    sentinel.innerHTML = '<span class="spinner"></span> Загружаем ещё…';
    listEl.appendChild(sentinel);
    setupFeedSentinel(sentinel);
  } else {
    feedAllLoaded = true;
  }
}
function setupFeedSentinel(sentinel) {
  if (_feedObserver) _feedObserver.disconnect();
  _feedObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !feedLoading && !feedAllLoaded) {
        feedLoading = true;
        setTimeout(() => {
          appendFeedChunk();
          feedLoading = false;
        }, 150);
      }
    });
  }, { rootMargin: "200px" });
  _feedObserver.observe(sentinel);
}
function buildMiniFeedItem(item) {
  const el = document.createElement("div");
  el.className = "mini-feed-item type-" + (item.type || "rating");

  const isAdmin = item.uid === ADMIN_UID;
  const adminStyle = isAdmin ? 'background:linear-gradient(135deg,var(--gold-1),var(--gold-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:700;' : '';
  const timeStr = item._tsSec ? formatTime(item._tsSec) : "";
  const lvl = isAdmin ? "👑" : (item.level || 1);

  let content = "";
  let icon = "⭐";

  if (item.type === "rating") {
    if (item._collapsed) {
      // Схлопнутая группа оценок
      const firstTier = getTier(item.final || 0);
      const coversHtml = (item._items || []).slice(0, 3).map(it => 
        it.releaseArtwork ? '<img src="' + escapeHtml(it.releaseArtwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : ''
      ).join("");
      content = 
        '<div class="mini-feed-content">' +
          '<div class="mini-covers-stack">' + coversHtml + '</div>' +
          '<div class="mini-feed-text">оценил <b>' + item._count + ' ' + plural(item._count, "релиз", "релиза", "релизов") + '</b></div>' +
        '</div>';
      icon = "📚";
    } else {
      const tier = getTier(item.final || 0);
      content =
        '<div class="mini-feed-content">' +
          (item.releaseArtwork ? '<img src="' + escapeHtml(item.releaseArtwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '') +
          '<div class="mini-feed-text">оценил <b>' + escapeHtml(item.releaseTitle || "") + '</b></div>' +
          '<div class="mini-feed-score" style="color:' + tier.color + '">' + (item.final || 0) + '</div>' +
        '</div>';
    }
  } else if (item.type === "comment") {
    icon = "💬";
    content =
      '<div class="mini-feed-content">' +
        (item.releaseArtwork ? '<img src="' + escapeHtml(item.releaseArtwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '') +
        '<div class="mini-feed-text">' +
          '<div class="mini-feed-comment">«' + escapeHtml((item.text || "").slice(0, 80)) + ((item.text || "").length > 80 ? "…" : "") + '»</div>' +
          '<div class="mini-feed-sub">на ' + escapeHtml(item.releaseTitle || "") + '</div>' +
        '</div>' +
      '</div>';
  } else if (item.type === "release") {
    icon = "🎵";
    content =
      '<div class="mini-feed-content">' +
        (item.releaseArtwork ? '<img src="' + escapeHtml(item.releaseArtwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '') +
        '<div class="mini-feed-text">добавил <b>' + escapeHtml(item.releaseTitle || "") + '</b></div>' +
      '</div>';
  }

  el.innerHTML =
    '<div class="mini-feed-icon">' + icon + '</div>' +
    '<div class="mini-feed-body">' +
      '<div class="mini-feed-head">' +
        '<span class="mini-feed-avatar" style="background:' + colorFromString(item.nickname || "?") + '">' + escapeHtml(item.avatar || "🎵") + '<span class="mini-level' + (isAdmin ? ' admin-mini' : '') + '">' + lvl + '</span></span>' +
        '<b class="' + (isAdmin ? "admin-nick" : "") + '" style="' + adminStyle + '">' + escapeHtml(item.nickname || "—") + '</b>' +
        '<span class="mini-feed-time">' + timeStr + '</span>' +
      '</div>' +
      content +
    '</div>';

  // Клик: на релиз — открыть
  if (item.releaseId && item.source) {
    el.style.cursor = "pointer";
    el.onclick = () => {
      const group = boardData.find(b => b.releaseId === String(item.releaseId) && b.source === item.source);
      if (group) {
        switchNav("board");
        setTimeout(() => openBoardModal(group), 250);
      } else {
        switchNav("main");
        loadAlbum({ id: item.releaseId, title: item.releaseTitle || "", cover: item.releaseArtwork || "", source: item.source });
      }
    };
  } else if (item._collapsed && item._items && item._items[0]) {
    el.style.cursor = "pointer";
    el.onclick = () => {
      const first = item._items[0];
      const group = boardData.find(b => b.releaseId === String(first.releaseId) && b.source === first.source);
      if (group) {
        switchNav("board");
        setTimeout(() => openBoardModal(group), 250);
      }
    };
  }

  return el;
}

// ---------- COMMENT REPORTS ----------
async function reportComment(commentId, source, releaseId) {
  if (!currentUser) { showToast("Нужно войти"); return; }
  if (myReportedComments.has(commentId)) { showToast("Вы уже жаловались на этот комментарий"); return; }
  const ok = await showConfirm({
    icon: "⚠️",
    title: "Пожаловаться на комментарий?",
    text: "Жалоба будет отправлена администрации для проверки.",
    okText: "Пожаловаться",
    okClass: "btn-danger"
  });
  if (!ok) return;
  try {
    await addDoc(collection(db, "reports"), {
      commentId,
      reporterUid: currentUser.uid,
      reporterNickname: userProfile.nickname,
      source,
      releaseId: String(releaseId),
      ts: serverTimestamp()
    });
    myReportedComments.add(commentId);
    saveLocalReported();
    showToast("Жалоба отправлена", { success: true });
    // Обновляем кнопку
    const btn = document.querySelector('.comment-report-btn[data-comment-id="' + commentId + '"]');
    if (btn) {
      btn.classList.add("reported");
      btn.textContent = "🚨 Жалоба отправлена";
    }
  } catch (e) { showToast("Ошибка: " + e.message); }
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



// ---------- ДОСКА С ПАГИНАЦИЕЙ ----------
function prepareBoardList() {
  let list = [...boardData];
  if (boardSearchLower) {
    list = list.filter(g =>
      (g.album.title || "").toLowerCase().includes(boardSearchLower) ||
      (g.album.artist || "").toLowerCase().includes(boardSearchLower) ||
      g.ratings.some(r => (r.nickname || "").toLowerCase().includes(boardSearchLower)));
  }
  const sort = document.getElementById("boardSort").value;
  list.sort((a, b) => {
    switch (sort) {
      case "date_desc": return b.lastTs - a.lastTs;
      case "date_asc":  return a.lastTs - b.lastTs;
      case "score_desc":return b.avgFinal - a.avgFinal;
      case "score_asc": return a.avgFinal - b.avgFinal;
      case "admin_desc":return (b.adminRating || -1) - (a.adminRating || -1);
      case "admin_asc": return (a.adminRating || 999) - (b.adminRating || 999);
      case "title_asc": return (a.album.title || "").localeCompare(b.album.title || "");
      case "artist_asc":return (a.album.artist || "").localeCompare(b.album.artist || "");
      default: return 0;
    }
  });
  boardFilteredList = list;
  boardRendered = 0;
  boardAllLoaded = false;
}
async function refreshBoard() {
  const listEl = document.getElementById("boardList");
  renderSkeletonList(listEl, 6);
  showFloatingLoader(true);
  boardRendered = 0;
  boardAllLoaded = false;
  try {
    const snap = await getDocs(collection(db, "ratings"));
    const all = snap.docs.map(d => d.data()).filter(r => !r.hidden);
    const groups = {};
    all.forEach(r => {
      const key = r.source + "_" + r.releaseId;
      if (!groups[key]) groups[key] = { key, album: r.album, source: r.source, releaseId: r.releaseId, ratings: [], adminRating: null, authorRating: null, authorTs: Infinity, lastTs: 0 };
      const g = groups[key];
      g.ratings.push({ uid: r.uid, nickname: r.nickname, avatar: r.avatar, level: r.level || 1, final: r.final, ts: r.ts?.seconds || 0, history: r.history || [] });
      if (r.uid === ADMIN_UID) g.adminRating = r.final;
      if ((r.ts?.seconds || 0) < g.authorTs) { g.authorTs = r.ts?.seconds || 0; g.authorRating = r.final; }
      if ((r.ts?.seconds || 0) > g.lastTs) g.lastTs = r.ts?.seconds || 0;
    });
    boardData = Object.values(groups).map(g => {
      const sum = g.ratings.reduce((a, r) => a + r.final, 0);
      g.avgFinal = Math.round(sum / g.ratings.length);
      g.userCount = g.ratings.length;
      return g;
    });
    renderBoardDynamicStats();
    prepareBoardList();
    renderBoard();
  } catch (e) {
    listEl.innerHTML = '<div class="empty-msg" style="color:var(--danger)">Ошибка: ' + escapeHtml(e.message) + '</div>';
  } finally { showFloatingLoader(false); }
}
function renderBoardDynamicStats() {
  const el = document.getElementById("boardDynamicStats");
  const totalRatings = boardData.reduce((a, g) => a + g.userCount, 0);
  const totalReleases = boardData.length;
  const avgAll = boardData.length ? Math.round(boardData.reduce((a, g) => a + g.avgFinal, 0) / boardData.length) : 0;
  el.innerHTML = '<div class="stat-chip">📀 Релизов: <b>' + totalReleases + '</b></div>' +
    '<div class="stat-chip">⭐ Оценок: <b>' + totalRatings + '</b></div>' +
    '<div class="stat-chip">📊 Средний балл: <b>' + avgAll + '</b></div>';
}
function onBoardSearchInput() {
  boardSearchLower = document.getElementById("boardSearchInput").value.trim().toLowerCase();
  renderBoard();
}
function renderBoard() {
  prepareBoardList();
  const listEl = document.getElementById("boardList");
  listEl.innerHTML = "";
  if (boardFilteredList.length === 0) {
    listEl.innerHTML = '<div class="empty-msg">Пока никто не оценил ни одного релиза.<br>Будьте первым!</div>';
    document.getElementById("boardStats").textContent = "0 релизов";
    return;
  }
  document.getElementById("boardStats").textContent = boardFilteredList.length + " релизов";
  appendBoardChunk();
}
function appendBoardChunk() {
  const listEl = document.getElementById("boardList");
  const end = Math.min(boardRendered + boardPageSize, boardFilteredList.length);
  const chunk = boardFilteredList.slice(boardRendered, end);
  const fragment = document.createDocumentFragment();
  const urlsToCache = [];
  chunk.forEach(g => {
    const tier = getTier(g.avgFinal);
    const el = document.createElement("div");
    el.className = "board-item " + tier.cssClass;
    const hasAdmin = g.adminRating != null;
      const singleNote = g.album.isSingleFromAlbum && g.album.parentAlbum
        ? ' <span style="font-size:.68rem; color:var(--vibe-1); background:rgba(126,224,212,.15); padding:2px 6px; border-radius:8px; font-weight:600;">🎯 из «' + escapeHtml(g.album.parentAlbum.title) + '»</span>'
        : '';
      // Находим оценку текущего пользователя (если есть)
      const myRating = currentUser ? g.ratings.find(r => r.uid === currentUser.uid) : null;
      let myChangeHtml = "";
      if (myRating && myRating.history && myRating.history.length > 0) {
        const lastChange = myRating.history[myRating.history.length - 1];
        myChangeHtml = '<div style="display:flex; align-items:center; gap:6px; font-size:.85rem; padding:2px 8px; background:rgba(0,0,0,.15); border-radius:8px;">' +
          '<span style="color:var(--text-dim); text-decoration:line-through; opacity:.7;">' + lastChange.oldFinal + '</span>' +
          '<span style="color:var(--text-dim);">→</span>' +
          '<span style="color:' + tier.color + '; font-weight:800;">' + myRating.final + '</span>' +
        '</div>';
      }
      el.innerHTML = '<img src="' + escapeHtml(g.album.artwork || "") + '" alt="" data-cacheable="1" data-src="' + escapeHtml(g.album.artwork || "") + '" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="info"><div class="title">' + escapeHtml(g.album.title) + tierBadgeHtml(tier) + singleNote + '</div>' +
        '<div class="artist">' + escapeHtml(g.album.artist) + '</div></div>' +
        '<div class="numbers">' +
          (myChangeHtml ? '<div class="num-block" style="min-width:auto;">' + myChangeHtml + '</div>' : '') +
          '<div class="num-block avg"><div class="num-label">Средняя (' + g.userCount + ')</div><div class="num-value">' + g.avgFinal + '</div></div>' +
          '<div class="num-block admin ' + (hasAdmin ? "" : "none") + '"><div class="num-label">👑 Админ</div><div class="num-value">' + (hasAdmin ? g.adminRating : "—") + '</div></div>' +
        '</div>';
    el.onclick = () => openBoardModal(g);
    fragment.appendChild(el);
    if (g.album.artwork) urlsToCache.push(g.album.artwork);
  });
  listEl.appendChild(fragment);
  boardRendered = end;
  scheduleCoverCaching(urlsToCache);
  hydrateImagesFromCache(listEl);
  const oldSentinel = document.getElementById("boardSentinel");
  if (oldSentinel) oldSentinel.remove();
  if (boardRendered < boardFilteredList.length) {
    const sentinel = document.createElement("div");
    sentinel.id = "boardSentinel";
    sentinel.style.cssText = "padding:20px; text-align:center; color:var(--text-dim); font-size:.85rem;";
    sentinel.innerHTML = '<span class="spinner"></span> Загружаем ещё…';
    listEl.appendChild(sentinel);
    setupBoardSentinel(sentinel);
  } else {
    const endMsg = document.createElement("div");
    endMsg.style.cssText = "padding:20px; text-align:center; color:var(--text-dim); font-size:.82rem; font-style:italic;";
    endMsg.textContent = "Это все релизы";
    listEl.appendChild(endMsg);
    boardAllLoaded = true;
  }
}
let _boardSentinelObserver = null;
function setupBoardSentinel(sentinel) {
  if (_boardSentinelObserver) _boardSentinelObserver.disconnect();
  _boardSentinelObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !boardLoadingMore && !boardAllLoaded) {
        boardLoadingMore = true;
        setTimeout(() => {
          appendBoardChunk();
          boardLoadingMore = false;
        }, 150);
      }
    });
  }, { rootMargin: "200px" });
  _boardSentinelObserver.observe(sentinel);
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

// ---------- КОММЕНТАРИИ ----------
async function loadComments(source, releaseId) {
  const listEl = document.getElementById("commentsList");
  listEl.innerHTML = '<div class="empty-msg" style="padding:14px;"><span class="spinner"></span></div>';
  try {
    const key = source + "_" + releaseId;
    const q = query(collection(db, "comments"), where("releaseKey", "==", key));
    const snap = await getDocs(q);
    const items = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    items.sort((a, b) => (a.ts?.seconds || 0) - (b.ts?.seconds || 0));
    document.getElementById("commentsCount").textContent = items.length ? "(" + items.length + ")" : "";
    if (items.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--text-dim);font-size:.85rem;padding:10px;">Пока нет комментариев. Будьте первым!</div>';
      return;
    }
    listEl.innerHTML = "";
    items.forEach(c => {
      listEl.appendChild(buildCommentItem(c, source, releaseId));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}
function buildCommentItem(c, source, releaseId) {
  const el = document.createElement("div");
  const isAdmin = c.uid === ADMIN_UID;
  const isMe = currentUser && c.uid === currentUser.uid;
  const isReported = myReportedComments.has(c._id);
  const isReply = /^@[^,]+,/.test(c.text || "");
  el.className = "comment-item" + (isAdmin ? " admin-comment" : "") + (isReply ? " reply-mention" : "");
  const time = c.ts?.seconds ? formatTime(c.ts.seconds) : "";
  const lvl = isAdmin ? "👑" : (c.level || 1);
  let textHtml;
  if (isReply) {
    const m = c.text.match(/^(@[^,]+),?\s*/);
    if (m) {
      const rest = c.text.slice(m[0].length);
      textHtml = '<span class="comment-mention">' + escapeHtml(m[1]) + '</span> ' + escapeHtml(rest);
    } else {
      textHtml = escapeHtml(c.text);
    }
  } else {
    textHtml = escapeHtml(c.text);
  }
  el.innerHTML = '<div class="comment-avatar" style="background:' + colorFromString(c.nickname || "?") + '">' + escapeHtml(c.avatar || "🎵") + '<span class="mini-level' + (isAdmin ? ' admin-mini' : '') + '">' + lvl + '</span></div>' +
    '<div class="comment-body">' +
      '<div class="comment-head">' +
        '<span class="comment-nick' + (isAdmin ? " admin-nick" : "") + '" data-uid="' + c.uid + '">' + escapeHtml(c.nickname || "Без имени") + (isAdmin ? " 👑" : "") + '</span>' +
        '<span class="comment-time">' + time + '</span>' +
      '</div>' +
      '<div class="comment-text">' + textHtml + '</div>' +
      '<div class="comment-actions">' +
        (currentUser ? '<button class="comment-reply-btn" title="Ответить">↩ Ответить</button>' : '') +
        (currentUser && !isMe ? '<button class="comment-report-btn' + (isReported ? " reported" : "") + '" data-comment-id="' + c._id + '" title="Пожаловаться">' + (isReported ? "🚨 Жалоба отправлена" : "⚠️ Пожаловаться") + '</button>' : '') +
      '</div>' +
    '</div>' +
    (isMe || (currentUser && currentUser.uid === ADMIN_UID) ? '<button class="comment-del" title="Удалить">×</button>' : "");
  // Клик по нику → профиль
  const nickEl = el.querySelector(".comment-nick");
  if (nickEl) nickEl.onclick = (ev) => { ev.stopPropagation(); openUserProfile(c.uid); };
  // Ответ
  const replyBtn = el.querySelector(".comment-reply-btn");
  if (replyBtn) replyBtn.onclick = () => replyToComment(c.nickname || "user");
  // Жалоба
  const reportBtn = el.querySelector(".comment-report-btn");
  if (reportBtn && !isReported) reportBtn.onclick = () => reportComment(c._id, source, releaseId);
  // Удаление
  const delBtn = el.querySelector(".comment-del");
  if (delBtn) delBtn.onclick = () => deleteComment(c._id, source, releaseId);
  return el;
}
async function submitComment() {
  if (!currentUser) { showToast("Нужно войти"); return; }
  const input = document.getElementById("commentInput");
  const text = input.value.trim();
  if (!text) return;
  if (!boardModalRelease) return;
  try {
    await addDoc(collection(db, "comments"), {
      uid: currentUser.uid,
      nickname: userProfile.nickname,
      avatar: userProfile.avatar || "🎵",
      level: getLevelByXp(userProfile.xp || 0).level,
      text,
      releaseKey: boardModalRelease.source + "_" + boardModalRelease.releaseId,
      source: boardModalRelease.source,
      releaseId: boardModalRelease.releaseId,
      ts: serverTimestamp()
    });
    input.value = "";
    await addXp(XP_REWARDS.comment, "Комментарий");
    // Лента
    await pushActivity({
      type: "comment",
      uid: currentUser.uid,
      nickname: userProfile.nickname,
      avatar: userProfile.avatar || "🎵",
      releaseId: String(boardModalRelease.releaseId),
      releaseTitle: boardModalRelease.album.title,
      releaseArtwork: boardModalRelease.album.artwork,
      releaseArtist: boardModalRelease.album.artist,
      source: boardModalRelease.source,
      text: text
    });
    await loadComments(boardModalRelease.source, boardModalRelease.releaseId);
    showToast("Комментарий добавлен", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}
async function deleteComment(id, source, releaseId) {
  const ok = await showConfirm({
    icon: "💬",
    title: "Удалить комментарий?",
    text: "Комментарий будет удалён безвозвратно.",
    okText: "Удалить",
    okClass: "btn-danger"
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "comments", id));
    await loadComments(source, releaseId);
    showToast("Комментарий удалён");
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ---------- ТОПЫ ----------
function switchTopTab(tab) {
  currentTopTab = tab;
  document.querySelectorAll(".top-tab").forEach(t => t.classList.toggle("active", t.dataset.top === tab));
  renderTops();
}
async function renderTops() {
  const listEl = document.getElementById("topsList");
  renderSkeletonList(listEl, 6);
  try {
    const snap = await getDocs(collection(db, "ratings"));
    const all = snap.docs.map(d => d.data()).filter(r => !r.hidden);
    const now = Date.now() / 1000;
    const periods = { all: Infinity, month: 30 * 86400, week: 7 * 86400 };
    const limitSec = periods[currentTopTab];
    const filtered = all.filter(r => (now - (r.ts?.seconds || 0)) <= limitSec || currentTopTab === "all");
    const groups = {};
    filtered.forEach(r => {
      const key = r.source + "_" + r.releaseId;
      if (!groups[key]) groups[key] = { album: r.album, source: r.source, releaseId: r.releaseId, ratings: [] };
      groups[key].ratings.push(r.final);
    });
    let list = Object.values(groups).map(g => {
      const sum = g.ratings.reduce((a, b) => a + b, 0);
      g.avg = Math.round(sum / g.ratings.length);
      g.count = g.ratings.length;
      return g;
    }).filter(g => g.count >= 2);
    list.sort((a, b) => b.avg - a.avg || b.count - a.count);
    if (list.length === 0) {
      listEl.innerHTML = '<div class="empty-msg">Пока нет релизов, которым поставили минимум 2 оценки.<br>Позовите друзей!</div>';
      return;
    }
    listEl.innerHTML = "";
    list.slice(0, 30).forEach((g, i) => {
      const tier = getTier(g.avg);
      const el = document.createElement("div");
      el.className = "board-item " + tier.cssClass;
      el.innerHTML = '<img src="' + escapeHtml(g.album.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="info"><div class="title">' + (i + 1) + '. ' + escapeHtml(g.album.title) + tierBadgeHtml(tier) + '</div>' +
        '<div class="artist">' + escapeHtml(g.album.artist) + '</div></div>' +
        '<div class="numbers"><div class="num-block avg"><div class="num-label">Средняя</div><div class="num-value">' + g.avg + '</div></div>' +
        '<div class="num-block"><div class="num-label">Оценок</div><div class="num-value" style="font-size:1rem;color:var(--text-dim);">' + g.count + '</div></div></div>';
      el.onclick = () => {
        const full = boardData.find(b => b.releaseId === g.releaseId && b.source === g.source);
        if (full) openBoardModal(full);
      };
      listEl.appendChild(el);
    });
    listEl.querySelectorAll("img").forEach(img => { img.dataset.cacheable = "1"; img.dataset.src = img.src; });
    scheduleCoverCaching(list.map(g => g.album.artwork).filter(Boolean));
    hydrateImagesFromCache(listEl);
  } catch (e) {
    listEl.innerHTML = '<div class="empty-msg" style="color:var(--danger)">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

// ---------- WISHLIST ----------
async function loadWishlist() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "wishlist"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    wishlistItems = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    wishlistItems.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
  } catch (e) { wishlistItems = []; }
}
function updateWishlistBadge() {
  const n = wishlistItems.length;
  const badge = document.getElementById("wishlistBadge");
  const mbadge = document.getElementById("mnavWishlistBadge");
  if (n > 0) {
    if (badge) { badge.textContent = n; badge.classList.remove("hidden"); }
    if (mbadge) { mbadge.textContent = n; mbadge.classList.remove("hidden"); }
  } else {
    if (badge) badge.classList.add("hidden");
    if (mbadge) mbadge.classList.add("hidden");
  }
}
async function addToWishlist() {
  if (!currentUser) { showToast("Нужно войти"); return; }
  if (!currentAlbum) return;
  try {
    const docId = currentUser.uid + "_" + currentAlbum.source + "_" + currentAlbum.id;
    const snap = await getDoc(doc(db, "wishlist", docId));
    if (snap.exists()) { showToast("Уже в списке «Оценю позже»"); return; }
    await setDoc(doc(db, "wishlist", docId), {
      uid: currentUser.uid, releaseId: String(currentAlbum.id), source: currentAlbum.source,
      album: { id: currentAlbum.id, title: currentAlbum.title, artist: currentAlbum.artist, artwork: currentAlbum.artwork, source: currentAlbum.source },
      ts: serverTimestamp()
    });
    await loadWishlist();
    updateWishlistBadge();
    showToast("Добавлено в «Оценю позже»", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}
async function removeFromWishlistIfExists(source, releaseId) {
  if (!currentUser) return;
  try {
    const docId = currentUser.uid + "_" + source + "_" + releaseId;
    const snap = await getDoc(doc(db, "wishlist", docId));
    if (snap.exists()) {
      await deleteDoc(doc(db, "wishlist", docId));
      await loadWishlist();
      updateWishlistBadge();
    }
  } catch (e) {}
}
async function removeFromWishlist(id) {
  try {
    await deleteDoc(doc(db, "wishlist", id));
    await loadWishlist();
    updateWishlistBadge();
    renderWishlist();
  } catch (e) {}
}
function renderWishlist() {
  const listEl = document.getElementById("wishlistList");
  if (wishlistItems.length === 0) { listEl.innerHTML = '<div class="empty-msg">Список пуст.<br>Добавляйте релизы кнопкой «Оценю позже» при открытии.</div>'; return; }
  listEl.innerHTML = "";
  wishlistItems.forEach(item => {
    const el = document.createElement("div");
    el.className = "wishlist-item";
    el.innerHTML = '<img src="' + escapeHtml(item.album.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="info"><div class="title">' + escapeHtml(item.album.title) + '</div><div class="artist">' + escapeHtml(item.album.artist) + '</div></div>' +
      '<div class="actions"><button onclick="rateFromWishlist(\'' + item.source + '\', \'' + item.album.id + '\')">Оценить</button>' +
      '<button class="btn-secondary" onclick="removeFromWishlist(\'' + item._id + '\')">Удалить</button></div>';
    listEl.appendChild(el);
  });
}
async function rateFromWishlist(source, id) {
  switchNav("main");
  await loadAlbum({ id, title: "", cover: "", source });
}
function openRandomWishlist() {
  if (wishlistItems.length === 0) { showToast("Список пуст"); return; }
  const r = wishlistItems[Math.floor(Math.random() * wishlistItems.length)];
  rateFromWishlist(r.source, r.album.id);
}

// ---------- ПРОФИЛЬ ----------
function renderProfile() {
  if (!userProfile) return;
  const isAdmin = currentUser && currentUser.uid === ADMIN_UID;

  // Скрываем/показываем блоки в зависимости от статуса
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

  // У админа скрываем сетку выбора и показываем пояснение
  const emojiLabel = document.getElementById("emojiLabel");
  const adminAvatarNote = document.getElementById("adminAvatarNote");
  if (emojiLabel) emojiLabel.style.display = isAdmin ? "none" : "";
  if (grid) grid.style.display = isAdmin ? "none" : "";
  if (adminAvatarNote) adminAvatarNote.classList.toggle("hidden", !isAdmin);

  // Обычным юзерам показываем сетку — без админских эмодзи
  const ADMIN_AVATARS = ["👑", "💎", "🪄", "🎩"];
  const availableEmojis = EMOJI_AVATARS.filter(e => !ADMIN_AVATARS.includes(e));
  availableEmojis.forEach(e => {
    const btn = document.createElement("button");
    btn.className = "emoji-cell" + (e === (userProfile.avatar || "🎵") ? " active" : "");
    btn.textContent = e;
    btn.onclick = () => selectAvatar(e);
    grid.appendChild(btn);
  });
  // Схемы
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
    renderSkeletonCards(stats, 5);
    setTimeout(renderProfileStatsInner, 150);
  } else {
    renderProfileStatsInner();
  }
  updateProfileLevelUI();
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
  const avgCover = myRatings.filter(r => r.coverRating).length
    ? (myRatings.filter(r => r.coverRating).reduce((a, r) => a + r.coverRating, 0) / myRatings.filter(r => r.coverRating).length).toFixed(1)
    : "—";
  stats.innerHTML =
    '<div class="profile-stat"><div class="num">' + myRatings.length + '</div>Оценок</div>' +
    '<div class="profile-stat"><div class="num">' + (avgFinal || "—") + '</div>Средний балл</div>' +
    '<div class="profile-stat"><div class="num">' + (tier ? tier.emoji : "—") + '</div>' + (tier ? tier.name : "Уровень") + '</div>' +
    '<div class="profile-stat"><div class="num">' + avgCover + '</div>Средняя обложка</div>' +
    '<div class="profile-stat"><div class="num">' + (favArtist || "—") + '</div>Любимый артист</div>';
}
function getFavoriteArtist() {
  if (myRatings.length === 0) return null;
  const byArtist = {};
  myRatings.forEach(r => {
    const a = r.album.artist || "";
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
    updateUserChip();
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
async function saveNickname() {
  if (!currentUser) return;
  const newNick = document.getElementById("profileNickInput").value.trim();
  if (!newNick || newNick.length < 2) { showToast("Ник слишком короткий"); return; }
  if (newNick.toLowerCase() === (userProfile.nicknameLower || "")) { showToast("Это ваш текущий ник"); return; }
  try {
    const newRef = doc(db, "nicknames", newNick.toLowerCase());
    const snap = await getDoc(newRef);
    if (snap.exists() && snap.data().uid !== currentUser.uid) { showToast("Ник уже занят"); return; }
    if (userProfile.nicknameLower) { try { await deleteDoc(doc(db, "nicknames", userProfile.nicknameLower)); } catch (e) {} }
    await setDoc(newRef, { uid: currentUser.uid });
    await updateDoc(doc(db, "users", currentUser.uid), { nickname: newNick, nicknameLower: newNick.toLowerCase() });
    userProfile.nickname = newNick;
    userProfile.nicknameLower = newNick.toLowerCase();
    updateUserChip();
    showToast("Ник обновлён", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ---------- NOW PLAYING ----------
function renderNowPlayingSection() {
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
async function openNowPlayingPicker() {
  if (!currentUser) { showToast("Нужно войти"); return; }
  document.getElementById("nowPlayingBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
  document.getElementById("nowPlayingSearch").value = "";
  document.getElementById("nowPlayingSuggestions").innerHTML = "";
  document.getElementById("nowPlayingSuggestions").classList.remove("open");
  setTimeout(() => document.getElementById("nowPlayingSearch").focus(), 150);
}
function closeNowPlayingPicker() {
  document.getElementById("nowPlayingBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}
function onNowPlayingSearchInput() {
  const q = document.getElementById("nowPlayingSearch").value.trim();
  clearTimeout(nowPlayingDebounce);
  const listEl = document.getElementById("nowPlayingSuggestions");
  if (q.length < 2) { listEl.classList.remove("open"); return; }
  listEl.innerHTML = '<div class="status"><span class="spinner"></span> Поиск…</div>';
  listEl.classList.add("open");
  nowPlayingDebounce = setTimeout(async () => {
    try {
      let items = [];
      const albums = await spotifySearchAlbums(q, 10);
      items = albums.map(mapSpotifyAlbum);
      if (items.length === 0) {
        listEl.innerHTML = '<div class="status">Ничего не найдено</div>';
        return;
      }
      nowPlayingSuggestions = items.slice(0, 10);
      nowPlayingActiveIndex = -1;
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
  }, DEBOUNCE_MS);
}
function onNowPlayingKeydown(e) {
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
    if (!userProfile.nowPlaying) userProfile.nowPlaying = {};
    userProfile.nowPlaying = {
      id: album.id, title: album.title, artist: album.artist,
      artwork: album.cover, source: album.source,
      ts: { seconds: Math.floor(Date.now() / 1000) }
    };
    renderNowPlayingSection();
    showToast("Слушаю сейчас обновлено", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}
async function clearNowPlaying() {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), { nowPlaying: null });
    userProfile.nowPlaying = null;
    renderNowPlayingSection();
    showToast("Убрано");
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ---------- ТОП-5 АРТИСТОВ ----------
function renderTopArtists() {
  const el = document.getElementById("topArtists");
  if (!el) return;
  if (!myRatings.length) { el.innerHTML = '<div class="empty-msg" style="padding:20px;">Пока нет оценок</div>'; return; }
  const byArtist = {};
  myRatings.forEach(r => {
    const a = r.album.artist || "";
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

// ---------- ТОП-10 / АНТИТОП-10 ----------
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

// ---------- ДОСТИЖЕНИЯ ----------
function renderAchievements() {
  const grid = document.getElementById("achievementsGrid");
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
async function checkAchievements() {
  if (!currentUser || !userProfile) return;
  // У админа нет достижений
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
    const a = r.album.artist;
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
        // лента
        pushActivity({
          type: "achievement",
          uid: currentUser.uid,
          nickname: userProfile.nickname,
          avatar: userProfile.avatar || "🎵",
          text: "получил достижение «" + ach.name + "»",
          emoji: ach.emoji
        });
      }
    });
    try {
      await updateDoc(doc(db, "users", currentUser.uid), { achievements: Array.from(unlocked) });
      userProfile.achievements = Array.from(unlocked);
    } catch (e) {}
    await addXp(toUnlock.length * XP_REWARDS.achievement, "Достижения");
    renderAchievements();
  }
}
function showAchievementToast(ach) {
  const container = document.getElementById("achievementToasts");
  const el = document.createElement("div");
  el.className = "achievement-toast";
  el.innerHTML = '<span class="ach-icon">' + ach.emoji + '</span>' +
    '<div><div style="font-size:.72rem;opacity:.8;text-transform:uppercase;letter-spacing:.06em;">Достижение</div>' +
    '<div>' + escapeHtml(ach.name) + '</div></div>';
  container.appendChild(el);
  setTimeout(() => el.remove(), 4600);
}

// ---------- СРАВНЕНИЕ ----------
function openCompareSelector() {
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
function compareGo() {
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
    '<div class="compare-col ' + (b.final >= a.final ? "win" : "") + '">' +
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
    addXp(XP_REWARDS.achievement, "Достижение");
  }
}
function compareBack() {
  document.getElementById("compareStage1").classList.remove("hidden");
  document.getElementById("compareStage2").classList.add("hidden");
}
function closeCompareModal() {
  document.getElementById("compareModalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}

// ---------- ПРОФИЛЬ ДРУГОГО ЮЗЕРА ----------
async function openUserProfile(uid) {
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

    // Разделяем на альбомы и синглы
    const albums = ratings.filter(r => !r.isSingle);
    const singles = ratings.filter(r => r.isSingle);

    const avgOf = arr => arr.length ? Math.round(arr.reduce((a, r) => a + r.final, 0) / arr.length) : 0;
    const avgAll = avgOf(ratings);
    const avgAlbums = avgOf(albums);
    const avgSingles = avgOf(singles);
    const tierAll = avgAll ? getTier(avgAll) : null;

    // Топ-3 лучших и худших (общий список, включая и альбомы, и синглы)
    const top3 = ratings.slice(0, 3);
    const bottom3 = ratings.length > 3 ? ratings.slice(-3).reverse() : [];

    // Любимый артист (по количеству оценок)
    const artistCount = {};
    ratings.forEach(r => {
      const a = r.album && r.album.artist;
      if (a) artistCount[a] = (artistCount[a] || 0) + 1;
    });
    const favArtistEntry = Object.entries(artistCount).sort((a, b) => b[1] - a[1])[0];
    const favArtist = favArtistEntry ? { name: favArtistEntry[0], count: favArtistEntry[1] } : null;

    let html = '';

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

// ---------- УВЕДОМЛЕНИЯ ----------
async function loadNotifications() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "notifications"), where("toUid", "==", currentUser.uid));
    const snap = await getDocs(q);
    notifications = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    notifications.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
  } catch (e) { notifications = []; }
}
function updateNotifDot() {
  const hasUnread = notifications.some(n => !n.read);
  const dot = document.getElementById("notifDot");
  if (hasUnread) dot.classList.remove("hidden");
  else dot.classList.add("hidden");
}
function openNotifications() {
  const listEl = document.getElementById("notifList");
  if (notifications.length === 0) listEl.innerHTML = '<div class="empty-msg">Пока нет уведомлений.</div>';
  else {
    listEl.innerHTML = "";
    notifications.slice(0, 50).forEach(n => {
      const el = document.createElement("div");
      el.className = "comment-item";
      el.innerHTML = '<div class="comment-body"><div class="comment-text">' + escapeHtml(n.text || "") + '</div>' +
        '<div class="comment-time" style="margin-top:4px;">' + (n.ts?.seconds ? formatTime(n.ts.seconds) : "") + '</div></div>';
      listEl.appendChild(el);
    });
  }
  document.getElementById("notifBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
  notifications.forEach(async n => {
    if (!n.read) { try { await updateDoc(doc(db, "notifications", n._id), { read: true }); } catch (e) {} }
  });
  notifications.forEach(n => n.read = true);
  updateNotifDot();
}
function closeNotifications() {
  document.getElementById("notifBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}
async function notifyUser(toUid, text) {
  try { await addDoc(collection(db, "notifications"), { toUid, text, read: false, ts: serverTimestamp() }); } catch (e) {}
}

// ---------- DRAFT ----------
function saveDraft() {
  if (!currentAlbum) return;
  try {
    const rows = document.querySelectorAll("#tracksList .track-row");
    const scores = [];
    rows.forEach(r => scores.push(getRowValue(r)));
    const draft = {
      album: currentAlbum, tracks: currentTracks,
      scores: currentTracks.length === 1 ? null : scores,
      singleValues: currentTracks.length === 1 ? { ...singleValues } : null,
      overall: overallValue, coverRating, mode: ratingMode, ts: Date.now()
    };
    localStorage.setItem(LS_DRAFT, JSON.stringify(draft));
  } catch (e) {}
}
function clearDraft() { try { localStorage.removeItem(LS_DRAFT); } catch (e) {} }
function checkDraftBanner() {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    if (!raw) { document.getElementById("continueBanner").classList.add("hidden"); return; }
    const draft = JSON.parse(raw);
    if (!draft.ts || (Date.now() - draft.ts) > 7 * 24 * 3600 * 1000) {
      localStorage.removeItem(LS_DRAFT);
      document.getElementById("continueBanner").classList.add("hidden"); return;
    }
    if (!draft.album) { document.getElementById("continueBanner").classList.add("hidden"); return; }
    document.getElementById("continueTitle").textContent = draft.album.title;
    document.getElementById("continueBanner").classList.remove("hidden");
  } catch (e) {}
}
async function continueDraft() {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    if (!raw) return;
    const draft = JSON.parse(raw);
    await loadAlbum({ id: draft.album.id, title: draft.album.title, cover: draft.album.artwork, source: draft.album.source });
    if (draft.mode && draft.mode !== ratingMode) setRatingMode(draft.mode);
    document.getElementById("continueBanner").classList.add("hidden");
  } catch (e) {}
}
function dismissDraft() {
  clearDraft();
  document.getElementById("continueBanner").classList.add("hidden");
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

// ---------- RESET ----------
function reset() {
  document.getElementById("step1").classList.remove("hidden");
  document.getElementById("step2").classList.add("hidden");
  document.getElementById("errorBox").textContent = "";
  document.getElementById("searchInput").value = "";
  closeSuggestions();
  lastSuggestions = []; activeIndex = -1;
  currentAlbum = null; currentTracks = [];
  trackDetails = {}; overallValue = 7; coverRating = 7;
  singleValues = {};
  document.getElementById("adminQuickActions").classList.add("hidden");
  const cl = document.getElementById("compareLine");
  if (cl) cl.classList.add("hidden");
  const cb = document.getElementById("coverBadge");
  if (cb) cb.classList.add("hidden");
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