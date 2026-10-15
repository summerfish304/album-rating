// ============================================================
// season-particles.js — анимированный фон по сезону
// ============================================================

import { db, doc, updateDoc } from './firebase.js';

let canvas = null;
let ctx = null;
let particles = [];
let animationId = null;
let currentType = null;
let _resizeHandler = null;

// Настройки плотности для каждого сезона (базовое число частиц)
const SEASON_CONFIG = {
  autumn: { count: 35, palette: ["#d97a3f", "#b85c1f", "#e0a52c", "#a8562a", "#c96a2f"], shape: "leaf", speed: [0.4, 1.1], size: [6, 11], sway: 1.2 },
  winter: { count: 70, palette: ["#ffffff", "#e6f0f8", "#b9d9ea"], shape: "snow", speed: [0.2, 0.7], size: [2, 5], sway: 0.6 },
  spring: { count: 28, palette: ["#ffc2d4", "#ffb3c8", "#ffd9e3", "#f5a6bf"], shape: "petal", speed: [0.5, 1.2], size: [5, 9], sway: 1.6 },
  summer: { count: 22, palette: ["#ffd27a", "#ffb347", "#fff3b0"], shape: "spark", speed: [0.3, 0.8], size: [3, 6], sway: 0.8 }
};

// ============================================================
// Инициализация canvas
// ============================================================
function ensureCanvas() {
  if (canvas) return true;
  canvas = document.getElementById("seasonCanvas");
  if (!canvas) {
    console.warn("seasonCanvas не найден в DOM");
    return false;
  }
  ctx = canvas.getContext("2d");
  resize();
  if (!_resizeHandler) {
    _resizeHandler = () => resize();
    window.addEventListener("resize", _resizeHandler);
  }
  return true;
}

function resize() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ============================================================
// Определение «слабое устройство»
// ============================================================
function getDensityMultiplier() {
  // Отключено вручную
  try {
    if (localStorage.getItem("albumRating_particlesOff_v1") === "1") return 0;
  } catch (e) {}

  // Слабое устройство
  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 2) return 0.4;
  if (cores <= 4) return 0.7;

  // prefers-reduced-motion — уважаем желание юзера
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0.3;
  } catch (e) {}

  return 1;
}

// ============================================================
// Создание частиц
// ============================================================
function rand(min, max) { return min + Math.random() * (max - min); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function makeParticle(type, cfg, w, h) {
  return {
    x: rand(0, w),
    y: rand(-h, h),
    size: rand(cfg.size[0], cfg.size[1]),
    speedY: rand(cfg.speed[0], cfg.speed[1]),
    speedX: rand(-0.3, 0.3) * cfg.sway,
    rotation: rand(0, Math.PI * 2),
    rotationSpeed: rand(-0.02, 0.02),
    color: pick(cfg.palette),
    opacity: rand(0.55, 0.95),
    swayPhase: rand(0, Math.PI * 2),
    swayAmp: rand(0.4, 1.2) * cfg.sway
  };
}

function createParticles(type) {
  const cfg = SEASON_CONFIG[type];
  if (!cfg) return [];
  const mult = getDensityMultiplier();
  const total = Math.round(cfg.count * mult);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const arr = [];
  for (let i = 0; i < total; i++) {
    arr.push(makeParticle(type, cfg, w, h));
  }
  return arr;
}

// ============================================================
// Рисование по типам
// ============================================================
function drawLeaf(p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation);
  ctx.fillStyle = p.color;
  ctx.globalAlpha = p.opacity;
  // Форма листа: два полукруга
  ctx.beginPath();
  ctx.moveTo(0, -p.size);
  ctx.quadraticCurveTo(p.size * 0.9, 0, 0, p.size);
  ctx.quadraticCurveTo(-p.size * 0.9, 0, 0, -p.size);
  ctx.fill();
  // Прожилка
  ctx.strokeStyle = "rgba(0,0,0,0.15)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -p.size);
  ctx.lineTo(0, p.size);
  ctx.stroke();
  ctx.restore();
}

function drawSnow(p) {
  ctx.save();
  ctx.globalAlpha = p.opacity;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPetal(p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation);
  ctx.fillStyle = p.color;
  ctx.globalAlpha = p.opacity;
  // Лепесток: пятиугольник с округлением
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * p.size;
    const y = Math.sin(angle) * p.size;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSpark(p) {
  ctx.save();
  ctx.globalAlpha = p.opacity;
  // Пульсирующая искорка
  const pulse = 0.7 + Math.sin(Date.now() * 0.003 + p.swayPhase) * 0.3;
  ctx.shadowBlur = 12 * pulse;
  ctx.shadowColor = p.color;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.size * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ============================================================
// Главный цикл
// ============================================================
function tick() {
  if (!ctx || !canvas) return;
  const w = window.innerWidth;
  const h = window.innerHeight;

  ctx.clearRect(0, 0, w, h);

  const cfg = SEASON_CONFIG[currentType];
  if (!cfg) return;

  const drawFn =
    currentType === "autumn" ? drawLeaf :
    currentType === "winter" ? drawSnow :
    currentType === "spring" ? drawPetal :
    drawSpark;

  for (const p of particles) {
    // Движение вниз + покачивание
    p.y += p.speedY;
    p.swayPhase += 0.01;
    p.x += Math.sin(p.swayPhase) * p.swayAmp * 0.3 + p.speedX;
    p.rotation += p.rotationSpeed;

    // Уход за границу — перерождение сверху
    if (p.y > h + 20) {
      p.y = -20;
      p.x = rand(0, w);
    }
    if (p.x < -20) p.x = w + 20;
    if (p.x > w + 20) p.x = -20;

    drawFn(p);
  }

  animationId = requestAnimationFrame(tick);
}

// ============================================================
// Публичное API
// ============================================================
export function startSeasonParticles(type) {
  if (!ensureCanvas()) return;
  if (!SEASON_CONFIG[type]) { stopSeasonParticles(); return; }
  if (currentType === type && animationId) return;

  stopSeasonParticles();
  currentType = type;
  particles = createParticles(type);
  resize();
  animationId = requestAnimationFrame(tick);
  canvas.classList.remove("hidden");
}

export function stopSeasonParticles() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  particles = [];
  currentType = null;
  if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (canvas) canvas.classList.add("hidden");
}

export function refreshParticles() {
  if (currentType) {
    particles = createParticles(currentType);
  }
}

// ============================================================
// Отключение анимации (сохраняется в localStorage)
// ============================================================
const PARTICLES_OFF_KEY = "albumRating_particlesOff_v1";

export function isParticlesOff() {
  try { return localStorage.getItem(PARTICLES_OFF_KEY) === "1"; } catch (e) { return false; }
}

export function setParticlesOff(off) {
  try {
    if (off) localStorage.setItem(PARTICLES_OFF_KEY, "1");
    else localStorage.removeItem(PARTICLES_OFF_KEY);
  } catch (e) {}
  if (off) {
    stopSeasonParticles();
  } else if (currentType) {
    startSeasonParticles(currentType);
  }
}

// Экспорт для отладки
if (typeof window !== "undefined") {
  window.__seasonParticles = {
    start: startSeasonParticles,
    stop: stopSeasonParticles,
    isOff: isParticlesOff,
    setOff: setParticlesOff
  };
}