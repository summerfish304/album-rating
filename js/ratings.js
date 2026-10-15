import { db, collection, doc, setDoc, getDoc, getDocs, query, where, deleteDoc, serverTimestamp } from './firebase.js';
import {
  ADMIN_UID, FINAL_MAX, MAX_TRACKS, ITUNES_PROXY,
  LS_RELEASE_CACHE, LS_MODE, LS_DRAFT,
  TIERS, XP_REWARDS, VERDICTS_ALBUM, VERDICTS_SINGLE, VERDICTS_TRACK,
  TRACK_CRITERIA, VIBE_KEY, MAIN_CRITERIA
} from './config.js';
import {
  getLevelByXp, computeFinalScore, computeSingleScore,
  getTier, getNextTier, plural, escapeHtml,
  formatTime
} from './utils.js';
import { cacheGet, cacheSet, scheduleCoverCaching, hydrateImagesFromCache } from './cache.js';
import { showToast, showFloatingLoader } from './ui.js';
import { showConfirm } from './confirm.js';
import { spotifyGetAlbum } from './search.js';

// ============================================================
// Состояние
// ============================================================
let currentUser = null;
let userProfile = null;
let currentAlbum = null;
let currentTracks = [];
let ratingMode = "slider";
let overallValue = 7;
let coverRating = 7;
let trackDetails = {};
let singleValues = {};
let modalTrackIndex = -1;
let modalValues = {};
let lastFinalScore = null;
let lastDeletedRating = null;
let lastDeletedRatingTimeout = null;
let myRatings = [];

// ============================================================
// Геттеры/сеттеры для main.js
// ============================================================
export function setRatingsContext(opts) {
  if (opts.currentUser !== undefined) currentUser = opts.currentUser;
  if (opts.userProfile !== undefined) userProfile = opts.userProfile;
}
export function getCurrentAlbum() { return currentAlbum; }
export function getCurrentTracks() { return currentTracks; }
export function getMyRatings() { return myRatings; }
export function getTrackDetails() { return trackDetails; }
export function getOverallValue() { return overallValue; }
export function getCoverRating() { return coverRating; }

// ============================================================
// Загрузка альбома и override
// ============================================================
export async function loadAlbum(album) {
  const errorBox = document.getElementById("errorBox");
  errorBox.textContent = "Загрузка треков…";
  showFloatingLoader(true);
  if (album.id && String(album.id).startsWith("single_")) {
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
    // Spotify отдаёт release_date в формате "YYYY-MM-DD" или "YYYY" или "YYYY-MM"
    const releaseDate = data.release_date || "";
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

    currentAlbum = { id: album.id, title, artist, artwork, source: "spotify", releaseDate };
    currentTracks = songs.map(s => ({ name: s.name, artist: s.artist }));
    trackDetails = {}; overallValue = 7; coverRating = 7; singleValues = {};

    cacheSet(LS_RELEASE_CACHE, cacheKey, { album: currentAlbum, songs: currentTracks });
    await prefillUserRatingIfExists("spotify", album.id);
    await applyOverride("spotify", album.id);
    renderAlbum();
    if (currentUser && currentUser.uid === ADMIN_UID) document.getElementById("adminQuickActions").classList.remove("hidden");
    else document.getElementById("adminQuickActions").classList.add("hidden");
    saveDraft();
  } catch (e) {
    errorBox.textContent = "Не удалось загрузить: " + e.message;
    showToast("Ошибка загрузки: " + e.message);
  } finally {
    showFloatingLoader(false);
  }
}

export async function applyOverride(source, releaseId) {
  try {
    const key = source + "_" + releaseId;
    const snap = await getDoc(doc(db, "overrides", key));
    if (snap.exists()) {
      const o = snap.data();
      if (o.title) currentAlbum.title = o.title;
      if (o.artist) currentAlbum.artist = o.artist;
      if (o.artwork) currentAlbum.artwork = o.artwork;
      if (o.tracks && o.tracks.length) currentTracks = o.tracks.map(n => ({ name: n, artist: currentAlbum.artist }));
      if (o.releaseDate) currentAlbum.releaseDate = o.releaseDate;
    }
  } catch (e) {}
}

export async function prefillUserRatingIfExists(source, releaseId) {
  if (!currentUser) return;
  try {
    const docId = source + "_" + releaseId + "_" + currentUser.uid;
    const snap = await getDoc(doc(db, "ratings", docId));
    if (snap.exists()) {
      const data = snap.data();
      currentAlbum.title = data.album.title || currentAlbum.title;
      currentAlbum.artist = data.album.artist || currentAlbum.artist;
      currentAlbum.artwork = data.album.artwork || currentAlbum.artwork;
      currentAlbum.releaseDate = data.album.releaseDate || currentAlbum.releaseDate;
      overallValue = data.overall || 7;
      coverRating = data.coverRating || 7;
      trackDetails = data.details || {};
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

// ============================================================
// Рендер альбома
// ============================================================
export function renderAlbum() {
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

function toggleSkit(index) {
  const track = currentTracks[index];
  if (!track) return;
  track.isSkit = !track.isSkit;
  const row = document.querySelector('#tracksList .track-row[data-index="' + index + '"]');
  if (row) {
    row.classList.toggle("is-skit", track.isSkit);
    const btn = row.querySelector(".skit-btn");
    if (btn) {
      btn.classList.toggle("active", track.isSkit);
      btn.title = track.isSkit ? "Убрать из скитов" : "Пометить как скит (не учитывается в итоге)";
    }
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

export function setRatingMode(mode) {
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

export function initRatingMode() {
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

export function onCoverRatingChange(v) {
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

export function updateScore() {
  let final, avg, overall, scores;
  if (currentTracks.length === 1) {
    const vibe = singleValues[VIBE_KEY] || 7;
    const { avgMain, singleScore } = computeSingleScore(singleValues);
    final = computeFinalScore([singleScore], vibe);
    avg = avgMain; overall = vibe; scores = [singleScore];
  } else {
    const rows = document.querySelectorAll("#tracksList .track-row");
    if (rows.length === 0) return;
    const allScores = [];
    rows.forEach(r => allScores.push(getRowValue(r)));
    const nonSkitScores = [];
    currentTracks.forEach((t, i) => {
      if (!t.isSkit) nonSkitScores.push(allScores[i]);
    });
    if (nonSkitScores.length === 0) {
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

export function toggleHistogram() {
  const box = document.getElementById("histogramBox");
  box.classList.toggle("collapsed");
  box.dataset.userToggled = "1";
}

// ============================================================
// Модалка трека
// ============================================================
export function openModal(index) {
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

export function closeModal() {
  document.getElementById("modalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
  modalTrackIndex = -1;
}

export function toggleHelp() { document.getElementById("helpBox").classList.toggle("hidden"); }
export function toggleHelpSingle() { document.getElementById("singleHelpBox").classList.toggle("hidden"); }

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

export function rateTrackAsSingle(onAlbumChosen) {
  const idx = modalTrackIndex;
  if (idx < 0 || !currentAlbum) return;
  const track = currentTracks[idx];
  if (!track) return;
  const syntheticId = "single_" + currentAlbum.source + "_" + currentAlbum.id + "_" + idx;
  const syntheticAlbum = {
    id: syntheticId,
    title: track.name,
    artist: track.artist || currentAlbum.artist,
    artwork: currentAlbum.artwork,
    source: currentAlbum.source,
    parentAlbum: { id: currentAlbum.id, title: currentAlbum.title, artist: currentAlbum.artist },
    isSingleFromAlbum: true,
    trackIndex: idx
  };
  closeModal();
  if (onAlbumChosen) onAlbumChosen(syntheticAlbum);
}

export function applyModalRating() {
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

// ============================================================
// Submit / удаление / история
// ============================================================
function rateLimitCheck() {
  try {
    const times = JSON.parse(localStorage.getItem("albumRating_ratingTimes_v12") || "[]");
    const now = Date.now();
    const recent = times.filter(t => now - t < 60000);
    if (recent.length >= 30) return { ok: false, reason: "Слишком много оценок за час. Попробуйте позже." };
    if (times.length > 0 && (now - times[times.length - 1]) < 5000) {
      const wait = Math.ceil((5000 - (now - times[times.length - 1])) / 1000);
      return { ok: false, reason: "Подождите " + wait + " сек. перед следующей оценкой" };
    }
    return { ok: true };
  } catch (e) { return { ok: true }; }
}
function rateLimitRegister() {
  try {
    const times = JSON.parse(localStorage.getItem("albumRating_ratingTimes_v12") || "[]");
    times.push(Date.now());
    if (times.length > 50) times.splice(0, times.length - 50);
    localStorage.setItem("albumRating_ratingTimes_v12", JSON.stringify(times));
  } catch (e) {}
}

export async function submitRating(onAfterSave) {
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
    scores = [];
    rows.forEach(r => scores.push(getRowValue(r)));
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
        history.push({ oldFinal: prev.final, newFinal: final, ts: Math.floor(Date.now() / 1000) });
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
        releaseDate: currentAlbum.releaseDate || "",
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
    clearDraft();
    showToast("Оценка сохранена: " + final, { success: true });
    if (onAfterSave) await onAfterSave({ isNew, final });
  } catch (e) {
    showToast("Ошибка сохранения: " + e.message);
  } finally { btn.disabled = false; }
}

export async function deleteMyRating(source, releaseId, onDone) {
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
  } catch (e) { showToast("Ошибка удаления: " + e.message); }
}

export async function loadMyRatings() {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "ratings"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    myRatings = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    myRatings.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
  } catch (e) { myRatings = []; }
}

export function renderHistory() {
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

export async function restoreFromMyRatings(item) {
  currentAlbum = {
    id: item.album.id, title: item.album.title, artist: item.album.artist,
    artwork: item.album.artwork, source: item.album.source || item.source,
    releaseDate: item.album.releaseDate || ""
  };
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

// ============================================================
// Draft
// ============================================================
export function saveDraft() {
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
export function clearDraft() { try { localStorage.removeItem(LS_DRAFT); } catch (e) {} }

export function checkDraftBanner() {
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

export async function continueDraft(onAlbumChosen) {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (onAlbumChosen) onAlbumChosen({ id: draft.album.id, title: draft.album.title, cover: draft.album.artwork, source: draft.album.source });
  } catch (e) {}
}

export function dismissDraft() {
  clearDraft();
  document.getElementById("continueBanner").classList.add("hidden");
}

export function reset() {
  document.getElementById("step1").classList.remove("hidden");
  document.getElementById("step2").classList.add("hidden");
  document.getElementById("errorBox").textContent = "";
  document.getElementById("searchInput").value = "";
  currentAlbum = null; currentTracks = [];
  trackDetails = {}; overallValue = 7; coverRating = 7;
  singleValues = {};
  document.getElementById("adminQuickActions").classList.add("hidden");
  const cl = document.getElementById("compareLine");
  if (cl) cl.classList.add("hidden");
  const cb = document.getElementById("coverBadge");
  if (cb) cb.classList.add("hidden");
}