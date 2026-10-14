// ============================================================
// season.js — сезоны (модель, визуал, баннер с обратным отсчётом)
// ============================================================

import { db, doc, getDoc, onSnapshot } from './firebase.js';
import { escapeHtml } from './utils.js';

// ============================================================
// Состояние модуля
// ============================================================
let currentSeason = null;      // { id, type, name, emoji, year, startedAt, endsAt, ... }
let seasonHistory = [];        // массив прошедших сезонов
let _seasonUnsub = null;
let _countdownTimer = null;
let callbacks = {};

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
  // Убираем все сезонные классы
  body.classList.remove("season-autumn", "season-winter", "season-spring", "season-summer");
  if (!currentSeason || !currentSeason.type) return;
  const cls = "season-" + currentSeason.type;
  if (SEASON_TYPES[currentSeason.type]) body.classList.add(cls);
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
}