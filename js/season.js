// ============================================================
// season.js — сезоны (модель, визуал, баннер с обратным отсчётом)
// ============================================================

import { db, doc, getDoc, onSnapshot } from './firebase.js';
import { escapeHtml, getTier } from './utils.js';
import { startSeasonParticles, stopSeasonParticles, isParticlesOff } from './season-particles.js';

// ============================================================
// Состояние модуля
// ============================================================
let currentSeason = null;      // { id, type, name, emoji, year, startedAt, endsAt, ... }
let seasonHistory = [];        // массив прошедших сезонов
let _seasonUnsub = null;
let _countdownTimer = null;
let callbacks = {};

// Предпочтение темы: "season" | "own"
// Дублируем в localStorage, чтобы применить сразу при загрузке.
const SEASON_THEME_PREF_KEY = "albumRating_seasonThemePref_v1";
let themePreference = "season";     // по умолчанию — сезон (вариант C)
let userScheme = "default";         // текущая схема юзера

export function getThemePreference() { return themePreference; }
export function setUserScheme(schemeId) {
  userScheme = schemeId || "default";
  applySeasonTheme();
}

export function setThemePreference(pref) {
  themePreference = (pref === "own") ? "own" : "season";
  try { localStorage.setItem(SEASON_THEME_PREF_KEY, themePreference); } catch (e) {}
  applySeasonTheme();
}

export function loadThemePreferenceFromLocal() {
  try {
    const v = localStorage.getItem(SEASON_THEME_PREF_KEY);
    if (v === "own" || v === "season") themePreference = v;
  } catch (e) {}
}

// Типы сезонов (для справки и валидации)
export const SEASON_TYPES = {
  autumn: { name: "Осень", emoji: "🍂" },
  winter: { name: "Зима",  emoji: "❄️" },
  spring: { name: "Весна", emoji: "🌸" },
  summer: { name: "Лето",  emoji: "☀️" }
};

// ============================================================
// Контекст из main.js
// ============================================================
export function setSeasonContext(opts) {
  if (opts.callbacks !== undefined) callbacks = opts.callbacks || {};
}

// ============================================================
// Геттеры
// ============================================================
export function getCurrentSeason() { return currentSeason; }
export function getSeasonHistory() { return seasonHistory; }

// ============================================================
// Загрузка (одноразовая)
// ============================================================
export async function loadSeasonOnce() {
  // Сначала проверяем, есть ли отладочный сезон
  const hasDebug = loadDebugSeasonIfAny();
  if (!hasDebug) {
    try {
      const snap = await getDoc(doc(db, "settings", "seasons"));
      if (snap.exists()) {
        const data = snap.data();
        currentSeason = data.current || null;
        seasonHistory = data.history || [];
      } else {
        currentSeason = null;
        seasonHistory = [];
      }
    } catch (e) {
      console.warn("Season load error:", e.message);
      currentSeason = null;
      seasonHistory = [];
    }
  }
  applySeasonTheme();
  renderSeasonBanner();
}

// ============================================================
// Подписка на изменения в реальном времени
// ============================================================
export function subscribeSeason() {
  if (_seasonUnsub) _seasonUnsub();
  try {
    _seasonUnsub = onSnapshot(doc(db, "settings", "seasons"), (snap) => {
      // Если есть отладочный сезон — не перезаписываем его данными Firestore
      if (loadDebugSeasonIfAny()) {
        applySeasonTheme();
        renderSeasonBanner();
        return;
      }
      if (snap.exists()) {
        const data = snap.data();
        currentSeason = data.current || null;
        seasonHistory = data.history || [];
      } else {
        currentSeason = null;
        seasonHistory = [];
      }
      applySeasonTheme();
      renderSeasonBanner();
    }, (err) => {
      console.warn("Season subscribe error:", err.message);
    });
  } catch (e) {}
}

// ============================================================
// Применение темы
// ============================================================
export function applySeasonTheme() {
  const body = document.body;

  // Убираем все сезонные и схемные классы
  body.classList.remove("season-autumn", "season-winter", "season-spring", "season-summer");
  body.classList.remove("scheme-ocean", "scheme-sunset", "scheme-forest", "scheme-berry", "scheme-mono");

  const hasSeason = currentSeason && currentSeason.type && SEASON_TYPES[currentSeason.type];
  const useSeason = hasSeason && themePreference === "season";

  if (useSeason) {
    // Применяем сезон
    body.classList.add("season-" + currentSeason.type);
    if (!isParticlesOff()) {
      startSeasonParticles(currentSeason.type);
    } else {
      stopSeasonParticles();
    }
  } else {
    // Применяем схему юзера
    if (userScheme && userScheme !== "default") {
      body.classList.add("scheme-" + userScheme);
    }
    stopSeasonParticles();
  }
}

// ============================================================
// Баннер с обратным отсчётом
// ============================================================
export function renderSeasonBanner() {
  const el = document.getElementById("seasonBanner");
  if (!el) return;

  if (!currentSeason || !currentSeason.endsAt) {
    el.classList.add("hidden");
    el.innerHTML = "";
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    return;
  }

  const emoji = currentSeason.emoji || SEASON_TYPES[currentSeason.type]?.emoji || "🎵";
  const name = currentSeason.name || SEASON_TYPES[currentSeason.type]?.name || "Сезон";
  const year = currentSeason.year || "";

  el.innerHTML =
    '<span class="season-banner-emoji">' + escapeHtml(emoji) + '</span>' +
    '<span class="season-banner-title">' + escapeHtml(name) + ' ' + escapeHtml(String(year)) + '</span>' +
    '<span class="season-banner-sep">·</span>' +
    '<span class="season-banner-countdown" id="seasonCountdown">—</span>';

  el.classList.remove("hidden");
  updateSeasonCountdown();

  if (_countdownTimer) clearInterval(_countdownTimer);
  // Обновляем раз в минуту — этого достаточно, часы не нужны
  _countdownTimer = setInterval(updateSeasonCountdown, 60000);
}

// ============================================================
// Рендер баннера «Сезон завершён» на главной
// ============================================================
export function renderFinishedSeasonBanner() {
  const el = document.getElementById("seasonFinishedBanner");
  if (!el) return;

  const result = getRecentlyFinishedSeason();
  if (!result) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  const { season } = result;
  const awards = season.awards || {};

  const renderAward = (label, item, isArtist) => {
    if (!item) return "";
    const tier = getTier(item.avg || 0);
    if (isArtist) {
      return '<div class="sfb-award sfb-award-artist">' +
        '<div class="sfb-award-label">' + label + '</div>' +
        '<div class="sfb-award-icon">🎤</div>' +
        '<div class="sfb-award-name">' + escapeHtml(item.name || "—") + '</div>' +
        '<div class="sfb-award-score" style="color:' + tier.color + '">' + (item.avg || 0) + '</div>' +
      '</div>';
    }
    return '<div class="sfb-award">' +
      '<div class="sfb-award-label">' + label + '</div>' +
      (item.album?.artwork
        ? '<img class="sfb-award-cover" src="' + escapeHtml(item.album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="sfb-award-cover sfb-noart">💿</div>') +
      '<div class="sfb-award-name">' + escapeHtml(item.album?.title || "—") + '</div>' +
      '<div class="sfb-award-artist">' + escapeHtml(item.album?.artist || "") + '</div>' +
      '<div class="sfb-award-score" style="color:' + tier.color + '">' + (item.avg || 0) + '</div>' +
    '</div>';
  };

  el.innerHTML =
    '<div class="sfb-header">' +
      '<div class="sfb-title">' +
        '<span class="sfb-emoji">' + (season.emoji || "🎵") + '</span>' +
        '<span>Сезон «' + escapeHtml(season.name || "") + ' ' + escapeHtml(String(season.year || "")) + '» завершён</span>' +
      '</div>' +
      '<button class="sfb-close" onclick="closeFinishedBanner(\'' + escapeHtml(season.id || "") + '\')" title="Скрыть">✕</button>' +
    '</div>' +
    '<div class="sfb-subtitle">🏆 Победители сезона</div>' +
    '<div class="sfb-grid">' +
      renderAward("🏆 Альбом сезона", awards.albumOfSeason, false) +
      renderAward("💿 Сингл сезона", awards.singleOfSeason, false) +
      renderAward("🎤 Артист сезона", awards.artistOfSeason, true) +
      renderAward("⭐ Выбор критиков", awards.criticsChoice, false) +
      renderAward("🌍 Выбор сообщества", awards.communityChoice, false) +
    '</div>';

  el.classList.remove("hidden");
}

function updateSeasonCountdown() {
  const el = document.getElementById("seasonCountdown");
  if (!el || !currentSeason || !currentSeason.endsAt) return;
  const endsMs = currentSeason.endsAt.seconds
    ? currentSeason.endsAt.seconds * 1000
    : new Date(currentSeason.endsAt).getTime();
  const now = Date.now();
  const diff = endsMs - now;

  if (diff <= 0) {
    el.textContent = "сезон завершён";
    return;
  }

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);

  if (days > 0) {
    const dayWord = plural(days, "день", "дня", "дней");
    el.textContent = "осталось " + days + " " + dayWord;
  } else if (hours > 0) {
    const hourWord = plural(hours, "час", "часа", "часов");
    el.textContent = "осталось " + hours + " " + hourWord;
  } else {
    el.textContent = "меньше часа";
  }
}

// Локальный plural, чтобы не тянуть из utils (там он тоже есть, но не критично)
function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// ============================================================
// Утилиты для будущего (награды, история и т.д.)
// ============================================================
export function isSeasonActive() {
  return !!(currentSeason && currentSeason.endsAt);
}

// ============================================================
// ОТЛАДКА: локальный сезон без Firestore
// ============================================================
const DEBUG_SEASON_KEY = "albumRating_debugSeason_v1";

/**
 * Устанавливает сезон локально (без записи в Firestore).
 * @param {object|null} season — объект сезона или null, чтобы сбросить.
 *   Формат:
 *   {
 *     id: "autumn-2026",
 *     type: "autumn",       // autumn | winter | spring | summer
 *     name: "Осень",
 *     emoji: "🍂",
 *     year: 2026,
 *     startedAt: "2026-09-01",   // строка ISO или timestamp
 *     endsAt: "2026-11-30"       // строка ISO или timestamp
 *   }
 */
export function __debugSetSeason(season) {
  if (season === null) {
    currentSeason = null;
    try { localStorage.removeItem(DEBUG_SEASON_KEY); } catch (e) {}
    applySeasonTheme();
    renderSeasonBanner();
    console.log("🧪 Debug season cleared");
    return;
  }
  // Конвертируем строки в объекты { seconds } для совместимости с Firestore-форматом
  const normalize = (v) => {
    if (!v) return null;
    if (typeof v === "object" && v.seconds) return v;
    const ms = new Date(v).getTime();
    if (isNaN(ms)) return null;
    return { seconds: Math.floor(ms / 1000) };
  };
  const fixed = {
    ...season,
    startedAt: normalize(season.startedAt),
    endsAt: normalize(season.endsAt)
  };
  currentSeason = fixed;
  try { localStorage.setItem(DEBUG_SEASON_KEY, JSON.stringify(fixed)); } catch (e) {}
  applySeasonTheme();
  renderSeasonBanner();
  console.log("🧪 Debug season set:", fixed);
}

/**
 * Загружает отладочный сезон из localStorage, если он есть.
 * Вызывается в loadSeasonOnce и subscribeSeason, чтобы перекрыть Firestore-данные.
 */
function loadDebugSeasonIfAny() {
  try {
    const raw = localStorage.getItem(DEBUG_SEASON_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type) {
      currentSeason = parsed;
      console.log("🧪 Loaded debug season from localStorage:", parsed);
      return true;
    }
  } catch (e) {}
  return false;
}

// Проверка, попал ли релиз в текущий сезон
export function isReleaseInCurrentSeason(releaseDateStr) {
  if (!currentSeason || !currentSeason.startedAt || !currentSeason.endsAt) return false;
  if (!releaseDateStr) return false;

  const releaseMs = new Date(releaseDateStr).getTime();
  if (isNaN(releaseMs)) return false;

  const startMs = currentSeason.startedAt.seconds
    ? currentSeason.startedAt.seconds * 1000
    : new Date(currentSeason.startedAt).getTime();
  const endMs = currentSeason.endsAt.seconds
    ? currentSeason.endsAt.seconds * 1000
    : new Date(currentSeason.endsAt).getTime();

  return releaseMs >= startMs && releaseMs <= endMs;
  // Экспорт для отладки через F12 → Console

}
if (typeof window !== "undefined") {
  window.__debugSetSeason = __debugSetSeason;
}

// ============================================================
// Недавно завершённый сезон (для баннера на главной)
// ============================================================
const FINISHED_BANNER_DAYS = 7;
const FINISHED_BANNER_HIDE_KEY = "albumRating_hiddenFinishedBanner_v1";

export function getRecentlyFinishedSeason() {
  if (!seasonHistory || !seasonHistory.length) return null;
  const now = Date.now();
  // Ищем самый свежий завершённый сезон
  const sorted = [...seasonHistory].sort((a, b) => {
    const ta = a.finishedAt?.seconds ? a.finishedAt.seconds * 1000 : new Date(a.finishedAt || 0).getTime();
    const tb = b.finishedAt?.seconds ? b.finishedAt.seconds * 1000 : new Date(b.finishedAt || 0).getTime();
    return tb - ta;
  });
  const latest = sorted[0];
  if (!latest || !latest.finishedAt) return null;

  const finishedMs = latest.finishedAt?.seconds
    ? latest.finishedAt.seconds * 1000
    : new Date(latest.finishedAt).getTime();
  const daysSince = (now - finishedMs) / 86400000;
  if (daysSince > FINISHED_BANNER_DAYS) return null;

  // Проверяем, не скрыл ли юзер
  try {
    const hidden = localStorage.getItem(FINISHED_BANNER_HIDE_KEY);
    if (hidden === latest.id) return null;
  } catch (e) {}

  return { season: latest, daysSince: Math.floor(daysSince) };
}

export function hideFinishedBanner(seasonId) {
  try { localStorage.setItem(FINISHED_BANNER_HIDE_KEY, seasonId || "1"); } catch (e) {}
}
// ============================================================
// Рендер архива сезонов (вкладка «Рейтинги → Сезоны»)
// ============================================================
export function switchRatingsTab(tab) {
  document.querySelectorAll(".ratings-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.rtab === tab);
  });
  document.querySelectorAll(".ratings-section").forEach(s => {
    s.classList.toggle("hidden", s.dataset.rsection !== tab);
  });
  if (tab === "seasons") renderSeasonsArchive();
}

export function renderSeasonsArchive() {
  const el = document.getElementById("seasonsArchive");
  if (!el) return;

  let html = '';

  // --- ТЕКУЩИЙ СЕЗОН ---
  if (currentSeason) {
    const startMs = currentSeason.startedAt?.seconds
      ? currentSeason.startedAt.seconds * 1000
      : new Date(currentSeason.startedAt).getTime();
    const endMs = currentSeason.endsAt?.seconds
      ? currentSeason.endsAt.seconds * 1000
      : new Date(currentSeason.endsAt).getTime();
    const now = Date.now();
    const daysLeft = Math.max(0, Math.ceil((endMs - now) / 86400000));
    const totalDays = Math.ceil((endMs - startMs) / 86400000);
    const passedDays = totalDays - daysLeft;
    const pct = totalDays > 0 ? Math.min(100, Math.max(0, (passedDays / totalDays) * 100)) : 0;

    html += '<div class="season-current-card">' +
      '<div class="scc-header">' +
        '<span class="scc-emoji">' + (currentSeason.emoji || "🎵") + '</span>' +
        '<div class="scc-info">' +
          '<div class="scc-title">' + escapeHtml(currentSeason.name || "Сезон") + ' ' + escapeHtml(String(currentSeason.year || "")) + '</div>' +
          '<div class="scc-sub">Идёт сейчас · осталось ' + daysLeft + ' ' + plural(daysLeft, "день", "дня", "дней") + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="scc-bar"><div class="scc-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
    '</div>';
  }

  // --- ИСТОРИЯ СЕЗОНОВ ---
  const history = (seasonHistory || []).slice().reverse();

  if (history.length === 0) {
    html += '<div class="empty-msg">' +
      (currentSeason
        ? 'Прошедших сезонов пока нет. Первый сезон ещё идёт!'
        : 'Пока ни один сезон не завершён.') +
    '</div>';
  } else {
    html += '<div class="seasons-history-header">📜 История сезонов</div>';
    history.forEach(season => {
      html += renderSeasonArchiveCard(season);
    });
  }

  el.innerHTML = html;
}

function renderSeasonArchiveCard(season) {
  const awards = season.awards || {};
  const finishedMs = season.finishedAt?.seconds
    ? season.finishedAt.seconds * 1000
    : new Date(season.finishedAt || 0).getTime();
  const finishedStr = finishedMs
    ? new Date(finishedMs).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" })
    : "";

  const renderAward = (label, item, isArtist) => {
    if (!item) return "";
    const tier = getTier(item.avg || 0);
    if (isArtist) {
      return '<div class="sac-card">' +
        '<div class="sac-card-label">' + label + '</div>' +
        '<div class="sac-card-body">' +
          '<div class="sac-card-icon">🎤</div>' +
          '<div class="sac-card-info">' +
            '<div class="sac-card-name">' + escapeHtml(item.name || "—") + '</div>' +
          '</div>' +
          '<div class="sac-card-score" style="color:' + tier.color + '">' + (item.avg || 0) + '</div>' +
        '</div>' +
      '</div>';
    }
    return '<div class="sac-card">' +
      '<div class="sac-card-label">' + label + '</div>' +
      '<div class="sac-card-body">' +
        (item.album?.artwork
          ? '<img class="sac-card-cover" src="' + escapeHtml(item.album.artwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
          : '<div class="sac-card-cover sac-card-noart">💿</div>') +
        '<div class="sac-card-info">' +
          '<div class="sac-card-name">' + escapeHtml(item.album?.title || "—") + '</div>' +
          '<div class="sac-card-artist">' + escapeHtml(item.album?.artist || "") + '</div>' +
        '</div>' +
        '<div class="sac-card-score" style="color:' + tier.color + '">' + (item.avg || 0) + '</div>' +
      '</div>' +
    '</div>';
  };

  const hasAwards = awards && (awards.albumOfSeason || awards.singleOfSeason || awards.artistOfSeason || awards.criticsChoice || awards.communityChoice);

  return '<div class="season-archive-card">' +
    '<div class="sac-header">' +
      '<span class="sac-emoji">' + (season.emoji || "🎵") + '</span>' +
      '<div class="sac-header-info">' +
        '<div class="sac-header-title">' + escapeHtml(season.name || "Сезон") + ' ' + escapeHtml(String(season.year || "")) + '</div>' +
        '<div class="sac-header-sub">Завершён ' + escapeHtml(finishedStr) + '</div>' +
      '</div>' +
    '</div>' +
    (hasAwards
      ? '<div class="sac-grid">' +
          renderAward("🏆 Альбом сезона", awards.albumOfSeason, false) +
          renderAward("💿 Сингл сезона", awards.singleOfSeason, false) +
          renderAward("🎤 Артист сезона", awards.artistOfSeason, true) +
          renderAward("⭐ Выбор критиков", awards.criticsChoice, false) +
          renderAward("🌍 Выбор сообщества", awards.communityChoice, false) +
        '</div>'
      : '<div class="sac-no-awards">Награды ещё не подсчитаны</div>') +
  '</div>';
}



if (typeof window !== "undefined") {
  window.__debugSetSeason = __debugSetSeason;
  window.__seasonTheme = {
    getPref: getThemePreference,
    setPref: setThemePreference,
    setUserScheme,
    apply: applySeasonTheme
  };
  window.__hideFinishedBanner = hideFinishedBanner;
  window.closeFinishedBanner = (seasonId) => {
    hideFinishedBanner(seasonId);
    renderFinishedSeasonBanner();
  };
  window.switchRatingsTab = switchRatingsTab;
}