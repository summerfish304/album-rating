import {
  db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  addDoc, query, where, serverTimestamp
} from './firebase.js';
import { ADMIN_UID, FINAL_MAX } from './config.js';
import {
  escapeHtml, plural, formatTime, getLevelByXp, colorFromString
} from './utils.js';
import { showToast, showFloatingLoader } from './ui.js';
import { showConfirm } from './confirm.js';
import { notifyUser } from './notifications.js';
import {
  getBoardData, getBoardModalRelease, closeBoardModal,
  refreshBoard, renderBoard, renderBoardDynamicStats
} from './board.js';

// ============================================================
// Контекст (устанавливается из main.js)
// ============================================================
let currentUser = null;
let userProfile = null;
let siteSettings = { maintenance: false, maintenanceMessage: "", announcement: null };
let currentAdminTab = "dashboard";
let _banTargetUid = null;
let _banSelectedDays = 7;
let callbacks = {};

export function setAdminContext(opts) {
  if (opts.currentUser !== undefined) currentUser = opts.currentUser;
  if (opts.userProfile !== undefined) userProfile = opts.userProfile;
  if (opts.siteSettings !== undefined) siteSettings = opts.siteSettings;
  if (opts.currentAdminTab !== undefined) currentAdminTab = opts.currentAdminTab;
  if (opts.callbacks !== undefined) callbacks = opts.callbacks || {};
}

export function getCurrentAdminTab() { return currentAdminTab; }

// ============================================================
// Роутер вкладок
// ============================================================
export function renderAdmin() {
  switchAdminTab(currentAdminTab);
}

export function switchAdminTab(tab) {
  currentAdminTab = tab;
  if (callbacks.onAdminTabChange) callbacks.onAdminTabChange(tab);
  document.querySelectorAll(".admin-tab").forEach(t => t.classList.toggle("active", t.dataset.admin === tab));
  const map = {
    dashboard: "adminDashboard",
    users: "adminUsers",
    reports: "adminReports",
    suggestions: "adminSuggestions",
    addrelease: "adminAddRelease",
    announcement: "adminAnnouncement",
    maintenance: "adminMaintenance"
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
  if (tab === "maintenance" && callbacks.onRenderMaintenance) callbacks.onRenderMaintenance();
}

// ============================================================
// Дашборд
// ============================================================
export async function renderAdminDashboard() {
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
    ratings.forEach(r => { const a = r.album && r.album.artist; if (a) artistCount[a] = (artistCount[a] || 0) + 1; });
    const userCount = {};
    ratings.forEach(r => { userCount[r.nickname] = (userCount[r.nickname] || 0) + 1; });
    const avgAll = ratings.length ? Math.round(ratings.reduce((a, r) => a + r.final, 0) / ratings.length) : 0;

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
    days.forEach(day => {
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
  } catch (e) {
    el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

// ============================================================
// Юзеры
// ============================================================
export async function renderAdminUsers() {
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
  } catch (e) {
    el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

// ============================================================
// Жалобы
// ============================================================
export async function renderAdminReports() {
  const el = document.getElementById("adminReports");
  el.innerHTML = '<div class="empty-msg"><span class="spinner"></span> Загрузка…</div>';
  try {
    const snap = await getDocs(collection(db, "reports"));
    const reports = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    const groups = {};
    reports.forEach(r => {
      if (!groups[r.commentId]) groups[r.commentId] = { commentId: r.commentId, source: r.source, releaseId: r.releaseId, reports: [] };
      groups[r.commentId].reports.push(r);
    });
    const list = Object.values(groups).sort((a, b) => b.reports.length - a.reports.length);
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
          '<button class="btn-danger" onclick="adminDeleteReportedComment(\'' + g.commentId + '\')">🗑 Удалить комментарий</button>' +
          (commentData ? '<button class="btn-danger" onclick="openBanModal(\'' + commentData.uid + '\',\'' + escapeHtml(commentData.nickname || "").replace(/'/g, "\\'") + '\')">🚫 Забанить автора</button>' : '') +
          '<button class="btn-secondary" onclick="clearCommentReports(\'' + g.commentId + '\')">✓ Жалобы обработаны</button>' +
        '</div>';
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

export async function adminJumpToComment(source, releaseId) {
  const group = getBoardData().find(b => b.source === source && b.releaseId === String(releaseId));
  if (group) {
    if (callbacks.onSwitchNav) callbacks.onSwitchNav("board");
    setTimeout(() => {
      if (callbacks.onOpenBoardModal) callbacks.onOpenBoardModal(group);
    }, 300);
  } else {
    await refreshBoard();
    const g2 = getBoardData().find(b => b.source === source && b.releaseId === String(releaseId));
    if (g2) {
      if (callbacks.onSwitchNav) callbacks.onSwitchNav("board");
      setTimeout(() => { if (callbacks.onOpenBoardModal) callbacks.onOpenBoardModal(g2); }, 300);
    } else {
      showToast("Релиз не найден на доске");
    }
  }
}

export async function adminDeleteReportedComment(commentId) {
  const ok = await showConfirm({
    icon: "🗑",
    title: "Удалить комментарий?",
    text: "Комментарий и все жалобы на него будут удалены.",
    okText: "Удалить",
    okClass: "btn-danger"
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "comments", commentId));
    const rs = await getDocs(query(collection(db, "reports"), where("commentId", "==", commentId)));
    await Promise.all(rs.docs.map(d => deleteDoc(doc(db, "reports", d.id))));
    showToast("Комментарий и жалобы удалены", { success: true });
    renderAdminReports();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export async function clearCommentReports(commentId) {
  try {
    const rs = await getDocs(query(collection(db, "reports"), where("commentId", "==", commentId)));
    await Promise.all(rs.docs.map(d => deleteDoc(doc(db, "reports", d.id))));
    showToast("Жалобы обработаны", { success: true });
    renderAdminReports();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ============================================================
// Бан
// ============================================================
export function openBanModal(uid, nickname) {
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

export function closeBanModal() {
  document.getElementById("banModalBackdrop").classList.remove("open");
  document.body.style.overflow = "";
  _banTargetUid = null;
}

export function selectBanDuration(days) {
  _banSelectedDays = days;
  document.querySelectorAll(".ban-duration-btn").forEach(b => b.classList.toggle("btn-gold", parseInt(b.dataset.days) === days));
  document.getElementById("banUntilDate").value = "";
}

export async function confirmBanUser() {
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
    if (getBoardData().length) refreshBoard();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export async function resetUserProgress(uid, nickname) {
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
    await updateDoc(doc(db, "users", uid), { xp: 0, achievements: [] });
    showToast("Прогресс сброшен", { success: true });
    renderAdminUsers();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export async function unbanUser(uid) {
  try {
    await deleteDoc(doc(db, "banned", uid));
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

// ============================================================
// Предложения
// ============================================================
export async function renderAdminSuggestions() {
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
  } catch (e) {
    el.innerHTML = '<div class="error">Ошибка: ' + escapeHtml(e.message) + '</div>';
  }
}

export async function approveSuggestion(id) {
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

export async function rejectSuggestion(id) {
  try {
    const snap = await getDoc(doc(db, "suggestions", id));
    const data = snap.exists() ? snap.data() : {};
    await updateDoc(doc(db, "suggestions", id), { status: "rejected" });
    if (data.uid) await notifyUser(data.uid, "❌ Ваше предложение «" + (data.title || "релиз") + "» отклонено");
    showToast("Отклонено");
    renderAdminSuggestions();
  } catch (e) { showToast("Ошибка"); }
}

export async function deleteSuggestion(id) {
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

// ============================================================
// Добавление релиза
// ============================================================
export function renderAdminAddRelease() {
  const el = document.getElementById("adminAddRelease");
  el.innerHTML =
    '<div class="hint" style="margin-bottom:12px;">Создайте релиз вручную. Он появится в поиске и станет доступен для оценки.</div>' +
    '<label>Название релиза</label><input type="text" id="addReleaseTitle" placeholder="Например: In Rainbows" style="margin-bottom:10px;">' +
    '<label>Артист</label><input type="text" id="addReleaseArtist" placeholder="Например: Radiohead" style="margin-bottom:10px;">' +
    '<label>Обложка (URL, необязательно)</label><input type="text" id="addReleaseArtwork" placeholder="https://…" style="margin-bottom:10px;">' +
    '<label>Треки (построчно)</label><textarea id="addReleaseTracks" placeholder="Трек 1&#10;Трек 2&#10;Трек 3"></textarea>' +
    '<div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;"><button onclick="createRelease()">💾 Создать релиз</button></div>';
}

export async function createRelease() {
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
    if (callbacks.onPushActivity) {
      await callbacks.onPushActivity({
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
    }
    showToast("Релиз создан", { success: true });
    document.getElementById("addReleaseTitle").value = "";
    document.getElementById("addReleaseArtist").value = "";
    document.getElementById("addReleaseArtwork").value = "";
    document.getElementById("addReleaseTracks").value = "";
  } catch (e) { showToast("Ошибка: " + e.message); }
}

// ============================================================
// Объявление
// ============================================================
export function renderAdminAnnouncement() {
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

export async function publishAnnouncement() {
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

export async function deleteAnnouncement() {
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

// ============================================================
// Редактирование релиза
// ============================================================
export function adminEditRelease() {
  const currentAlbum = callbacks.getCurrentAlbum ? callbacks.getCurrentAlbum() : null;
  const currentTracks = callbacks.getCurrentTracks ? callbacks.getCurrentTracks() : [];
  if (!currentAlbum) return;
  document.getElementById("editTitle").value = currentAlbum.title;
  document.getElementById("editArtist").value = currentAlbum.artist;
  document.getElementById("editArtwork").value = currentAlbum.artwork;
  document.getElementById("editTracks").value = currentTracks.map(t => t.name).join("\n");
  document.getElementById("editReleaseBackdrop").classList.add("open");
  document.body.style.overflow = "hidden";
}

export function closeEditRelease() {
  document.getElementById("editReleaseBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}

export async function saveEditRelease() {
  const currentAlbum = callbacks.getCurrentAlbum ? callbacks.getCurrentAlbum() : null;
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
    if (callbacks.onReloadAlbum) callbacks.onReloadAlbum();
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export async function resetEditRelease() {
  const currentAlbum = callbacks.getCurrentAlbum ? callbacks.getCurrentAlbum() : null;
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

// ============================================================
// Удаление релиза с доски
// ============================================================
export async function adminDeleteReleaseFromBoard() {
  const group = getBoardModalRelease();
  if (!group) return;
  const ok = await showConfirm({
    icon: "⚠️",
    title: "Удалить релиз с доски?",
    text: "Будут удалены ВСЕ оценки этого релиза от всех пользователей, а также комментарии. Действие необратимо.",
    okText: "Удалить всё",
    okClass: "btn-danger"
  });
  if (!ok) return;
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

    closeBoardModal();
    await refreshBoard();
    if (callbacks.onAfterDeleteRelease) callbacks.onAfterDeleteRelease();

    showToast(`Релиз удалён: ${ratingsSnap.docs.length} ${plural(ratingsSnap.docs.length, "оценка", "оценки", "оценок")}`, { success: true });
  } catch (e) {
    showToast("Ошибка удаления: " + e.message);
  } finally {
    showFloatingLoader(false);
  }
}