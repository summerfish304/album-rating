import { db, collection, query, where, getDocs, doc, updateDoc, addDoc, serverTimestamp } from './firebase.js';
import { formatTime, escapeHtml } from './utils.js';

let notifications = [];

export async function loadNotifications(currentUser) {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "notifications"), where("toUid", "==", currentUser.uid));
    const snap = await getDocs(q);
    notifications = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    notifications.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
  } catch (e) { notifications = []; }
}

export function updateNotifDot() {
  const hasUnread = notifications.some(n => !n.read);
  const dot = document.getElementById("notifDot");
  if (hasUnread) dot.classList.remove("hidden");
  else dot.classList.add("hidden");
}

export function openNotifications() {
  const listEl = document.getElementById("notifList");
  if (notifications.length === 0) listEl.innerHTML = '<div class="empty-msg">Пока нет уведомлений.</div>';
  else {
    listEl.innerHTML = "";
    notifications.slice(0, 50).forEach(n => {
      const el = document.createElement("div");
      el.className = "comment-item";
      el.innerHTML = '<div class="comment-body"><div class="comment-text">' + escapeHtml(n.text) + '</div>' +
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

export function closeNotifications() {
  document.getElementById("notifBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}

export async function notifyUser(toUid, text) {
  try { await addDoc(collection(db, "notifications"), { toUid, text, read: false, ts: serverTimestamp() }); } catch (e) {}
}