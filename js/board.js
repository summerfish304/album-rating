import { db, collection, doc, getDoc, getDocs, setDoc, addDoc, query, where, deleteDoc, serverTimestamp, onSnapshot, orderBy, fbLimit } from './firebase.js';
import {
  ADMIN_UID, FINAL_MAX, BOARD_PAGE_SIZE, FEED_PAGE_SIZE, FEED_MAX_ITEMS,
  LS_REPORTS, MAIN_CRITERIA
} from './config.js';
import {
  getTier, getLevelByXp, plural, escapeHtml, colorFromString, formatTime,
  tierBadgeHtml
} from './utils.js';
import { cacheGet, scheduleCoverCaching, hydrateImagesFromCache } from './cache.js';
import { showToast, showFloatingLoader, renderSkeletonList } from './ui.js';
import { showConfirm } from './confirm.js';

let currentUser = null;
let userProfile = null;
let boardData = [];
let boardModalRelease = null;
let compareSelection = [];
let currentTopTab = "all";
let boardSearchLower = "";
let boardPageSize = BOARD_PAGE_SIZE;
let boardRendered = 0;
let boardFilteredList = [];
let boardLoadingMore = false;
let boardAllLoaded = false;
let myReportedComments = new Set();
let currentFeedTab = "all";
let feedData = [];
let _feedObserver = null;
let _feedUnsub = null;
let _boardSentinelObserver = null;
let _myFollowing = new Set();   // uid, на которые подписан текущий юзер
let _followingLoaded = false;

// ============================================================
// Геттеры/сеттеры
// ============================================================
let callbacks = {};

export function setBoardContext(opts) {
  if (opts.currentUser !== undefined) currentUser = opts.currentUser;
  if (opts.userProfile !== undefined) userProfile = opts.userProfile;
  if (opts.callbacks !== undefined) callbacks = opts.callbacks || {};
}
export function getBoardData() { return boardData; }
export function getCompareSelection() { return compareSelection; }
export function setCompareSelection(val) { compareSelection = val; }
export function getBoardModalRelease() { return boardModalRelease; }
export function getMyReportedComments() { return myReportedComments; }
export function getMyFollowing() { return _myFollowing; }
export function getCurrentFeedTab() { return currentFeedTab; }
export function loadLocalReported() {
  try {
    const raw = localStorage.getItem(LS_REPORTS);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) myReportedComments = new Set(arr);
  } catch (e) {}
}
export function saveLocalReported() {
  try {
    localStorage.setItem(LS_REPORTS, JSON.stringify(Array.from(myReportedComments)));
  } catch (e) {}
}

// ============================================================
// Доска
// ============================================================
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

export async function refreshBoard() {
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

export function renderBoardDynamicStats() {
  const el = document.getElementById("boardDynamicStats");
  if (!el) return;
  const totalRatings = boardData.reduce((a, g) => a + g.userCount, 0);
  const totalReleases = boardData.length;
  const avgAll = boardData.length ? Math.round(boardData.reduce((a, g) => a + g.avgFinal, 0) / boardData.length) : 0;
  el.innerHTML = '<div class="stat-chip">📀 Релизов: <b>' + totalReleases + '</b></div>' +
    '<div class="stat-chip">⭐ Оценок: <b>' + totalRatings + '</b></div>' +
    '<div class="stat-chip">📊 Средний балл: <b>' + avgAll + '</b></div>';
}

export function onBoardSearchInput() {
  boardSearchLower = document.getElementById("boardSearchInput").value.trim().toLowerCase();
  renderBoard();
}

export function renderBoard() {
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

// ============================================================
// Модалка релиза на доске
// ============================================================
export async function openBoardModal(group) {
  boardModalRelease = group;
  document.getElementById("boardModalCover").src = group.album.artwork || "";
  document.getElementById("boardModalCover").onerror = function() { this.style.visibility = "hidden"; };
  document.getElementById("boardModalTitle").textContent = group.album.title;
  // Делаем артиста кликабельным
  const artistEl = document.getElementById("boardModalArtist");
  const artistName = group.album.artist || "";
  artistEl.textContent = artistName;
  if (artistName && group.album.artistId) {
    // Если у релиза есть artistId — сразу ссылка
    artistEl.classList.add("clickable-artist");
    artistEl.onclick = () => openArtistFromBoard(group.album.artistId);
  } else {
    // Если нет artistId — при клике ищем артиста через поиск Spotify
    artistEl.classList.add("clickable-artist");
    artistEl.onclick = () => openArtistByNameFromBoard(artistName);
  }
  document.getElementById("boardModalAvg").textContent = group.avgFinal;
  document.getElementById("boardModalAvgHint").textContent = "из " + FINAL_MAX + " · " + group.userCount + " " + plural(group.userCount, "оценка", "оценки", "оценок");
  const hasAdmin = group.adminRating != null;
  document.getElementById("boardModalAdmin").textContent = hasAdmin ? group.adminRating : "—";
  document.getElementById("boardModalAdminHint").textContent = hasAdmin ? "из " + FINAL_MAX : "ещё не оценил";
  if (currentUser && currentUser.uid === ADMIN_UID) document.getElementById("adminBoardQuick").classList.remove("hidden");
  else document.getElementById("adminBoardQuick").classList.add("hidden");
  renderBoardModalUsers(group, callbacks);
  await loadReviews(group.source, group.releaseId, callbacks);
  document.getElementById("boardModalBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}

function renderBoardModalUsers(group, callbacks) {
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
      if (ev.target.classList.contains("del-sm")) return;
      if (ev.target.closest(".clickable-name") || ev.target.closest(".clickable-avatar")) {
        ev.stopPropagation();
        if (callbacks && callbacks.onOpenUserProfile) callbacks.onOpenUserProfile(r.uid);
        return;
      }
      showUserRatingInline(group, r.uid, row);
    };
    const delBtn = row.querySelector(".del-sm");
    if (delBtn) {
      delBtn.onclick = async (ev) => {
        ev.stopPropagation();
        if (callbacks && callbacks.onDeleteMyRating) {
          await callbacks.onDeleteMyRating(group.source, group.releaseId, () => {
            closeBoardModal();
            if (callbacks.onAfterDelete) callbacks.onAfterDelete();
          });
        }
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

export function closeBoardModal() {
  document.getElementById("boardModalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}

// ============================================================
// Комментарии
// ============================================================
export async function loadComments(source, releaseId, callbacks) {
  const listEl = document.getElementById("commentsList");
  listEl.innerHTML = '<div class="empty-msg" style="padding:14px;"><span class="spinner"></span></div>';
  try {
    const key = source + "_" + releaseId;
    const q = query(collection(db, "comments"), where("releaseKey", "==", key));
    const snap = await getDocs(q);
    const items = snap.docs.map(d => ({ _id: d.id, ...d.data() })).filter(c => !c.hidden);
    items.sort((a, b) => (a.ts?.seconds || 0) - (b.ts?.seconds || 0));
    document.getElementById("commentsCount").textContent = items.length ? "(" + items.length + ")" : "";
    if (items.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--text-dim);font-size:.85rem;padding:10px;">Пока нет комментариев. Будьте первым!</div>';
      return;
    }
    listEl.innerHTML = "";
    items.forEach(c => {
      listEl.appendChild(buildCommentItem(c, source, releaseId, callbacks));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

function buildCommentItem(c, source, releaseId, callbacks) {
  const el = document.createElement("div");
  const isAdmin = c.uid === ADMIN_UID;
  const isMe = currentUser && c.uid === currentUser.uid;
  const isReported = myReportedComments.has(c._id);
  const cText = c.text || "";
  const isReply = /^@[^,]+,/.test(cText);
  el.className = "comment-item" + (isAdmin ? " admin-comment" : "") + (isReply ? " reply-mention" : "");
  const time = c.ts?.seconds ? formatTime(c.ts.seconds) : "";
  const lvl = isAdmin ? "👑" : (c.level || 1);
  let textHtml;
  if (isReply) {
    const m = cText.match(/^(@[^,]+),?\s*/);
    if (m) {
      const rest = cText.slice(m[0].length);
      textHtml = '<span class="comment-mention">' + escapeHtml(m[1]) + '</span> ' + escapeHtml(rest);
    } else {
      textHtml = escapeHtml(cText);
    }
  } else {
    textHtml = escapeHtml(cText);
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
  const nickEl = el.querySelector(".comment-nick");
  if (nickEl) nickEl.onclick = (ev) => {
    ev.stopPropagation();
    if (callbacks && callbacks.onOpenUserProfile) callbacks.onOpenUserProfile(c.uid);
  };
  const replyBtn = el.querySelector(".comment-reply-btn");
  if (replyBtn) replyBtn.onclick = () => replyToComment(c.nickname || "user");
  const reportBtn = el.querySelector(".comment-report-btn");
  if (reportBtn && !isReported) reportBtn.onclick = () => reportComment(c._id, source, releaseId);
  const delBtn = el.querySelector(".comment-del");
  if (delBtn) delBtn.onclick = () => deleteComment(c._id, source, releaseId, callbacks);
  return el;
}

export async function reportComment(commentId, source, releaseId) {
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
    const btn = document.querySelector('.comment-report-btn[data-comment-id="' + commentId + '"]');
    if (btn) {
      btn.classList.add("reported");
      btn.textContent = "🚨 Жалоба отправлена";
    }
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export function replyToComment(nickname) {
  const input = document.getElementById("commentInput");
  if (!input) return;
  input.value = "@" + nickname + ", " + input.value.replace(/^@[^,]+, /, "");
  input.focus();
  input.scrollIntoView({ behavior: "smooth", block: "center" });
}

export async function submitComment(callbacks) {
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
    if (callbacks && callbacks.onCommentAdded) await callbacks.onCommentAdded(text);
    await loadComments(boardModalRelease.source, boardModalRelease.releaseId, callbacks);
    showToast("Комментарий добавлен", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}

async function deleteComment(id, source, releaseId, callbacks) {
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
    await loadComments(source, releaseId, callbacks);
    showToast("Комментарий удалён");
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ============================================================
// Топы
// ============================================================
export function switchTopTab(tab) {
  currentTopTab = tab;
  document.querySelectorAll(".top-tab").forEach(t => t.classList.toggle("active", t.dataset.top === tab));
  renderTops();
}

export async function renderTops() {
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

// ============================================================
// ПОДПИСКИ
// ============================================================
function subDocId(followerUid, followingUid) {
  return followerUid + "_" + followingUid;
}

export async function loadMySubscriptions() {
  if (!currentUser) { _myFollowing = new Set(); _followingLoaded = true; return; }
  try {
    const q = query(collection(db, "subscriptions"), where("followerUid", "==", currentUser.uid));
    const snap = await getDocs(q);
    _myFollowing = new Set(snap.docs.map(d => d.data().followingUid));
    _followingLoaded = true;
  } catch (e) {
    console.warn("loadMySubscriptions error:", e.message);
    _myFollowing = new Set();
    _followingLoaded = true;
  }
}

export function isFollowing(uid) {
  return _myFollowing.has(uid);
}

export async function subscribeToUser(uid) {
  if (!currentUser) { showToast("Нужно войти"); return false; }
  if (!uid || uid === currentUser.uid) return false;
  try {
    await setDoc(doc(db, "subscriptions", subDocId(currentUser.uid, uid)), {
      followerUid: currentUser.uid,
      followingUid: uid,
      ts: serverTimestamp()
    });
    _myFollowing.add(uid);
    showToast("Вы подписались", { success: true });
    if (typeof window !== "undefined" && window.__refreshOpenUserProfile) {
      window.__refreshOpenUserProfile();
    }
    return true;
  } catch (e) {
    showToast("Ошибка: " + e.message);
    return false;
  }
}

export async function unsubscribeFromUser(uid) {
  if (!currentUser) return false;
  if (!uid) return false;
  try {
    await deleteDoc(doc(db, "subscriptions", subDocId(currentUser.uid, uid)));
    _myFollowing.delete(uid);
    showToast("Вы отписались");
    if (typeof window !== "undefined" && window.__refreshOpenUserProfile) {
      window.__refreshOpenUserProfile();
    }
    return true;
  } catch (e) {
    showToast("Ошибка: " + e.message);
    return false;
  }
}

export async function getSubscriptionCounts(uid) {
  if (!uid) return { followers: 0, following: 0 };
  try {
    const [followersSnap, followingSnap] = await Promise.all([
      getDocs(query(collection(db, "subscriptions"), where("followingUid", "==", uid))),
      getDocs(query(collection(db, "subscriptions"), where("followerUid", "==", uid)))
    ]);
    return { followers: followersSnap.size, following: followingSnap.size };
  } catch (e) {
    return { followers: 0, following: 0 };
  }
}

export function switchFeedTab(tab) {
  currentFeedTab = (tab === "subs") ? "subs" : "all";
  document.querySelectorAll(".feed-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.feed === currentFeedTab);
  });
  renderFeed(callbacks || {});
}

// ============================================================
// Лента активности
// ============================================================
export function subscribeFeed(callbacks) {
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
      renderFeed(callbacks);
      renderHotToday(callbacks);
    }, (err) => {
      console.warn("Feed subscribe error:", err.message);
      feedData = [];
      renderFeed(callbacks);
      renderHotToday(callbacks);
    });
  } catch (e) {}
}

export async function refreshFeed(callbacks) {
  subscribeFeed(callbacks);
  renderHotToday(callbacks);
  showToast("Обновлено");
}

export function renderFeed(callbacks) {
  const listEl = document.getElementById("feedList");
  if (!listEl) return;
  const dayAgo = (Date.now() / 1000) - 86400;
  let recent = feedData.filter(item => (item._tsSec || 0) >= dayAgo);
  recent = recent.filter(item => item.type !== "achievement");

  // Фильтр по подпискам
  if (currentFeedTab === "subs") {
    if (!_followingLoaded && currentUser) {
      // подгрузка ещё идёт — покажем пусто с намёком
      loadMySubscriptions().then(() => renderFeed(callbacks));
    }
    recent = recent.filter(item => item.uid && _myFollowing.has(item.uid));
  }

  const collapsed = collapseRatings(recent);
  const shown = collapsed.slice(0, 8);
  listEl.innerHTML = "";
  if (shown.length === 0) {
    if (currentFeedTab === "subs") {
      listEl.innerHTML = '<div class="empty-msg">' +
        'В подписках пока тихо.<br>' +
        '<span style="font-size:.8rem;color:var(--text-dim);">Подпишитесь на кого-нибудь из профиля — и здесь появится их активность.</span>' +
      '</div>';
    } else {
      listEl.innerHTML = '<div class="empty-msg">Пока ничего не произошло.<br>Будьте первым!</div>';
    }
    return;
  }
  shown.forEach(item => {
    listEl.appendChild(buildMiniFeedItem(item, callbacks));
  });
}

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
      result.push({ ...current, _collapsed: true, _count: group.length, _items: group });
    }
    i = j;
  }
  return result;
}

function buildMiniFeedItem(item, callbacks) {
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
  } else if (item.type === "review") {
    icon = "📝";
    const text = item.text || "";
    const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
    // Убираем markdown-звёздочки для превью в ленте
    const cleanPreview = preview.replace(/\*\*/g, "").replace(/\*/g, "");
    content =
      '<div class="mini-feed-content">' +
        (item.releaseArtwork ? '<img src="' + escapeHtml(item.releaseArtwork) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '') +
        '<div class="mini-feed-text">' +
          '<div class="mini-feed-review">«' + escapeHtml(cleanPreview) + '»</div>' +
          '<div class="mini-feed-sub">рецензия на <b>' + escapeHtml(item.releaseTitle || "") + '</b></div>' +
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

  if (item.releaseId && item.source) {
    el.style.cursor = "pointer";
    el.onclick = () => {
      const group = boardData.find(b => b.releaseId === String(item.releaseId) && b.source === item.source);
      if (group) {
        if (callbacks && callbacks.onSwitchNav) callbacks.onSwitchNav("board");
        setTimeout(() => openBoardModal(group, callbacks), 250);
      } else {
        if (callbacks && callbacks.onLoadAlbum) callbacks.onLoadAlbum({ id: item.releaseId, title: item.releaseTitle || "", cover: item.releaseArtwork || "", source: item.source });
      }
    };
  } else if (item._collapsed && item._items && item._items[0]) {
    el.style.cursor = "pointer";
    el.onclick = () => {
      const first = item._items[0];
      const group = boardData.find(b => b.releaseId === String(first.releaseId) && b.source === first.source);
      if (group) {
        if (callbacks && callbacks.onSwitchNav) callbacks.onSwitchNav("board");
        setTimeout(() => openBoardModal(group, callbacks), 250);
      }
    };
  }
  return el;
}

// ============================================================
// Hot today
// ============================================================
export async function renderHotToday(callbacks) {
  const gridEl = document.getElementById("hotGrid");
  if (!gridEl) return;
  gridEl.innerHTML = '<div class="empty-msg" style="padding:14px;"><span class="spinner"></span></div>';
  try {
    const snap = await getDocs(collection(db, "ratings"));
    const all = snap.docs.map(d => d.data()).filter(r => !r.hidden);
    const dayAgo = (Date.now() / 1000) - 86400;
    const recent = all.filter(r => (r.ts?.seconds || 0) >= dayAgo);
    const groups = {};
    recent.forEach(r => {
      const key = r.source + "_" + r.releaseId;
      if (!groups[key]) groups[key] = { album: r.album, source: r.source, releaseId: r.releaseId, ratings: [], comments: 0 };
      groups[key].ratings.push(r.final);
    });
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
    const topByScore = [...list].sort((a, b) => b.avg - a.avg || b.count - a.count).slice(0, 3);
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
            '<div class="hot-info"><div class="hot-title">' + escapeHtml(it.album.title || "") + '</div><div class="hot-artist">' + escapeHtml(it.album.artist || "") + '</div></div>' +
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
    gridEl.querySelectorAll(".hot-item").forEach(el => {
      el.onclick = () => {
        const src = el.dataset.source;
        const rid = el.dataset.releaseId;
        const group = boardData.find(b => b.source === src && b.releaseId === String(rid));
        if (group) {
          if (callbacks && callbacks.onSwitchNav) callbacks.onSwitchNav("board");
          setTimeout(() => openBoardModal(group, callbacks), 250);
        } else if (callbacks && callbacks.onLoadAlbum) {
          callbacks.onLoadAlbum({ id: rid, title: "", cover: "", source: src });
        }
      };
    });
  } catch (e) {
    gridEl.innerHTML = '<div class="empty-msg" style="color:var(--danger)">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

// ============================================================
// Экспорт вспомогательного для main.js
// ============================================================
export function setCurrentTopTab(tab) { currentTopTab = tab; }

// ============================================================
// РЕЦЕНЗИИ (замена комментариев)
// ============================================================

// Загрузить все рецензии к релизу
export async function loadReviews(source, releaseId, callbacks) {
  const listEl = document.getElementById("reviewsList");
  const countEl = document.getElementById("reviewsCount");
  if (!listEl) return;

  listEl.innerHTML = '<div class="empty-msg" style="padding:14px;"><span class="spinner"></span></div>';

  try {
    const q = query(
      collection(db, "reviews"),
      where("source", "==", source),
      where("releaseId", "==", String(releaseId))
    );
    const snap = await getDocs(q);
    let items = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    // Сортируем: сначала свежие
    items.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));

    if (countEl) countEl.textContent = items.length ? "(" + items.length + ")" : "";

    if (items.length === 0) {
      listEl.innerHTML =
        '<div class="reviews-empty">' +
          '<div class="reviews-empty-icon">📝</div>' +
          '<div class="reviews-empty-text">Пока никто не написал рецензию на этот релиз.</div>' +
          (currentUser
            ? '<button class="btn-secondary btn-sm" onclick="openCalculatorFromBoard()">✏️ Оценить и написать</button>'
            : '') +
        '</div>';
      return;
    }

    listEl.innerHTML = "";
    items.forEach(r => {
      listEl.appendChild(buildReviewItem(r, source, releaseId, callbacks));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

// Один блок рецензии
function buildReviewItem(review, source, releaseId, callbacks) {
  const el = document.createElement("div");
  const isAdmin = review.uid === ADMIN_UID;
  const isMe = currentUser && review.uid === currentUser.uid;
  el.className = "review-item" + (isAdmin ? " admin-review" : "") + (isMe ? " my-review" : "");

  const time = review.ts?.seconds ? formatTime(review.ts.seconds) : "";
  const lvl = isAdmin ? "👑" : (review.level || 1);
  const avatar = review.avatar || "🎵";
  const nick = review.nickname || "Без имени";
  const edited = review.editedAt ? ' <span class="review-edited">(изм.)</span>' : '';

  el.innerHTML =
    '<div class="review-avatar" style="background:' + colorFromString(nick) + '">' +
      escapeHtml(avatar) +
      '<span class="mini-level' + (isAdmin ? ' admin-mini' : '') + '">' + lvl + '</span>' +
    '</div>' +
    '<div class="review-body">' +
      '<div class="review-head">' +
        '<span class="review-nick' + (isAdmin ? " admin-nick" : "") + '" data-uid="' + review.uid + '">' +
          escapeHtml(nick) + (isAdmin ? " 👑" : "") +
        '</span>' +
        '<span class="review-time">' + time + edited + '</span>' +
      '</div>' +
      '<div class="review-text">' + formatReviewText(review.text || "") + '</div>' +
      '<div class="review-actions">' +
        (isMe
          ? '<button class="review-action-btn review-delete-btn" title="Удалить рецензию">🗑 Удалить</button>' +
            '<button class="review-action-btn review-rewrite-btn" title="Удалить и написать заново">✏️ Написать заново</button>'
          : (currentUser && !isAdmin
              ? '<button class="review-action-btn review-report-btn" title="Пожаловаться">⚠️ Пожаловаться</button>'
              : '')
        ) +
      '</div>' +
    '</div>';

  // Клик по нику — открыть профиль
  const nickEl = el.querySelector(".review-nick");
  if (nickEl && callbacks && callbacks.onOpenUserProfile) {
    nickEl.onclick = (ev) => {
      ev.stopPropagation();
      callbacks.onOpenUserProfile(review.uid);
    };
  }

  // Удалить
  const delBtn = el.querySelector(".review-delete-btn");
  if (delBtn) {
    delBtn.onclick = () => deleteReview(review._id, source, releaseId, callbacks);
  }

  // Написать заново
  const rewriteBtn = el.querySelector(".review-rewrite-btn");
  if (rewriteBtn) {
    rewriteBtn.onclick = () => rewriteReview(review, source, releaseId, callbacks);
  }

  // Жалоба
  const reportBtn = el.querySelector(".review-report-btn");
  if (reportBtn) {
    reportBtn.onclick = () => reportReview(review._id, source, releaseId);
  }

  return el;
}

// Форматирование текста: **жирный**, *курсив*, переносы
export function formatReviewText(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  // Жирный **текст**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Курсив *текст* (но не трогаем уже преобразованные **)
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Переносы строк
  html = html.replace(/\n/g, "<br>");

  return html;
}

// Удалить свою рецензию
async function deleteReview(reviewId, source, releaseId, callbacks) {
  const ok = await showConfirm({
    icon: "🗑",
    title: "Удалить рецензию?",
    text: "Рецензию нельзя восстановить. Вы сможете написать новую на этот же релиз.",
    okText: "Удалить",
    okClass: "btn-danger"
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "reviews", reviewId));
    showToast("Рецензия удалена", { success: true });
    await loadReviews(source, releaseId, callbacks);
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// Написать заново: удаляет и открывает калькулятор
async function rewriteReview(review, source, releaseId, callbacks) {
  const ok = await showConfirm({
    icon: "✏️",
    title: "Написать заново?",
    text: "Старая рецензия будет удалена. Откроется экран оценки релиза, где вы сможете написать новую.",
    okText: "Продолжить",
    okClass: "btn-secondary"
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "reviews", review._id));
    showToast("Старая рецензия удалена", { success: true });

    // Закрываем модалку и открываем калькулятор
    closeBoardModal();
    if (callbacks && callbacks.onSwitchNav) callbacks.onSwitchNav("main");
    // Загружаем этот же релиз в калькулятор
    setTimeout(() => {
      if (callbacks && callbacks.onLoadAlbum) {
        callbacks.onLoadAlbum({ id: review.releaseId, title: "", cover: "", source: review.source });
      }
    }, 300);
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// Пожаловаться на рецензию
async function reportReview(reviewId, source, releaseId) {
  if (!currentUser) { showToast("Нужно войти"); return; }
  if (myReportedComments.has(reviewId)) { showToast("Вы уже жаловались на эту рецензию"); return; }

  const ok = await showConfirm({
    icon: "⚠️",
    title: "Пожаловаться на рецензию?",
    text: "Жалоба будет отправлена администрации.",
    okText: "Пожаловаться",
    okClass: "btn-danger"
  });
  if (!ok) return;

  try {
    await addDoc(collection(db, "reports"), {
      reviewId: reviewId,
      reporterUid: currentUser.uid,
      reporterNickname: userProfile.nickname,
      source: source,
      releaseId: String(releaseId),
      type: "review",
      ts: serverTimestamp()
    });
    myReportedComments.add(reviewId);
    saveLocalReported();
    showToast("Жалоба отправлена", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}
// ============================================================
// КЛИК ПО АРТИСТУ ИЗ МОДАЛКИ ДОСКИ
// ============================================================
function openArtistFromBoard(artistId) {
  if (!artistId) return;
  closeBoardModal();
  if (typeof window.openArtistFromBoard === "function") {
    window.openArtistFromBoard(artistId);
  }
}

function openArtistByNameFromBoard(artistName) {
  if (!artistName) return;
  closeBoardModal();
  if (typeof window.openArtistByName === "function") {
    window.openArtistByName(artistName);
  }
}