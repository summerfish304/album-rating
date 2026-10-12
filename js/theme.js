import { SCHEMES, SCHEME_KEY, LS_THEME } from './config.js';
import { showToast } from './ui.js';

let currentScheme = "";

export function getCurrentScheme() {
  return currentScheme;
}

export function applySchemeFromProfile(userProfile) {
  const scheme = (userProfile && userProfile.scheme) || "default";
  applyScheme(scheme);
}

export function applyScheme(schemeId) {
  const all = SCHEMES.map(s => s.class).filter(Boolean);
  document.body.classList.remove(...all);
  const s = SCHEMES.find(x => x.id === schemeId) || SCHEMES[0];
  if (s.class) document.body.classList.add(s.class);
  currentScheme = schemeId;
}

export function saveSchemeLocally(schemeId) {
  try { localStorage.setItem(SCHEME_KEY, schemeId); } catch (e) {}
}

export function loadSchemeLocally() {
  try { return localStorage.getItem(SCHEME_KEY) || "default"; } catch (e) { return "default"; }
}

export function initTheme() {
  const saved = localStorage.getItem(LS_THEME) || "auto";
  applyTheme(saved);
}

export function applyTheme(theme) {
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

export function cycleTheme() {
  const cur = localStorage.getItem(LS_THEME) || "auto";
  const next = cur === "auto" ? "light" : cur === "light" ? "night" : "auto";
  localStorage.setItem(LS_THEME, next);
  applyTheme(next);
  const names = { auto: "по системе", light: "светлая", night: "ночная" };
  showToast("Тема: " + names[next]);
}