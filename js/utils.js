import { LEVELS, TIERS, FINAL_MAX, MAIN_CRITERIA } from './config.js';

export function getLevelByXp(xp) {
  let result = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.xp) result = l; else break; }
  return result;
}
export function getNextLevel(xp) {
  for (const l of LEVELS) { if (xp < l.xp) return l; }
  return null;
}
// ═══════════════════════════════════════════════════════
// ФИНАЛЬНАЯ ФОРМУЛА ОЦЕНИВАНИЯ
// ═══════════════════════════════════════════════════════
// 1. База = средняя по трекам (без скитов), 1–10.
// 2. База × 36 = пропорциональная шкала (5 → 180, 10 → 360).
// 3. Вайб — множитель 0.55..1.0 (сильно, но не убивает).
// 4. 360 — только если ВСЕ треки = 10 И вайб = 10.
//    Любое отклонение — максимум 359.
export function computeFinalScore(scores, vibe) {
  if (!scores || scores.length === 0) return 1;

  const n = scores.length;

  // Шаг 1. База — средняя по трекам
  const base = scores.reduce((a, b) => a + b, 0) / n;

  // Шаг 2. Вайб — множитель 0.55 (вайб 1) .. 1.0 (вайб 10)
  const vibeFactor = 0.5 + (vibe / 10) * 0.5;

  // Шаг 3. Сырой итог
  let raw = base * 36 * vibeFactor;

  // Шаг 4. 360 — только при полном идеале
  const allPerfect = scores.every(s => s >= 10);
  const vibePerfect = vibe >= 10;
  if (allPerfect && vibePerfect) {
    return 360;
  } else {
    raw = Math.min(359, raw);
  }

  return Math.max(1, Math.min(360, Math.round(raw)));
}
// Расчёт итоговой оценки сингла (1–10, дробное) по 4 критериям.
// 10 — только если ВСЕ 4 критерия = 10. Каждый балл каждого критерия даёт вклад.
// Вайб учитывается отдельно в computeFinalScore.
export function computeSingleScore(values) {
  let sum = 0;
  MAIN_CRITERIA.forEach(c => { sum += values[c.key] || 7; });
  const avgMain = sum / MAIN_CRITERIA.length;

  const allMainPerfect = MAIN_CRITERIA.every(c => (values[c.key] || 7) === 10);

  let singleScore;
  if (allMainPerfect) {
    singleScore = 10;
  } else {
    // Округляем вниз до 0.25 — сохраняем вклад каждого балла,
    // но не даём достичь 10 при неидеальных критериях.
    singleScore = Math.max(1, Math.min(9.75, Math.floor(avgMain * 4) / 4));
  }

  return { avgMain, singleScore };
}
export function getTier(finalScore) {
  const pct = finalScore / FINAL_MAX;
  for (const t of TIERS) if (pct >= t.min && pct < t.max) return t;
  return TIERS[TIERS.length - 1];
}
export function getNextTier(finalScore) {
  const pct = finalScore / FINAL_MAX;
  for (const t of TIERS) if (pct < t.min) return t;
  return null;
}
export function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return "hsl(" + hue + ", 65%, 55%)";
}
export function tierMedalHtml(tier, size) {
  size = size || "";
  const cls = "tier-medal " + tier.medal + (size ? " " + size : "");
  return '<span class="' + cls + '" title="' + escapeHtml(tier.name) + '">' + tier.emoji + '</span>';
}

// Новый бейдж тира: цветной, с текстом
export function tierBadgeHtml(tier) {
  const tierClass = tier.cssClass; // tier-coal, tier-bronze, ..., tier-brill
  return '<span class="tier-text-badge ' + tierClass + '" title="' + escapeHtml(tier.name) + '">' +
    tier.emoji + ' ' + escapeHtml(tier.name) +
  '</span>';
}

export function formatTime(sec) {
  const d = new Date(sec * 1000);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return diffMin + " мин назад";
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return diffH + " ч назад";
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return diffD + " дн назад";
  return d.toLocaleDateString("ru-RU");
}