import { db, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from './firebase.js';
import { ADMIN_UID, MAINTENANCE_DEFAULT_MSG, LS_ANNOUNCEMENT } from './config.js';
import { showToast } from './ui.js';
import { showConfirm } from './confirm.js';

let siteSettings = { maintenance: false, maintenanceMessage: "", announcement: null };
let _settingsUnsub = null;
let _maintenancePollTimer = null;

export function getSiteSettings() {
  return siteSettings;
}

export async function loadSiteSettingsOnce(currentUser) {
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
  applyMaintenanceState(currentUser);
  applyAnnouncementState();
}

export function subscribeSiteSettings(currentUser) {
  if (_settingsUnsub) _settingsUnsub();
  try {
    _settingsUnsub = onSnapshot(doc(db, "settings", "site"), (snap) => {
      if (snap.exists()) siteSettings = snap.data();
      else siteSettings = { maintenance: false, maintenanceMessage: "", announcement: null };
      applyMaintenanceState(currentUser);
      applyAnnouncementState();
    }, () => {});
  } catch (e) {}
}

export function startMaintenancePolling(currentUser) {
  if (_maintenancePollTimer) clearInterval(_maintenancePollTimer);
  _maintenancePollTimer = setInterval(() => {
    if (siteSettings.maintenance && currentUser && currentUser.uid !== ADMIN_UID) {
      loadSiteSettingsOnce(currentUser);
    }
  }, 30000);
}

export function applyMaintenanceState(currentUser) {
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

export function applyAnnouncementState() {
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

export function dismissAnnouncement() {
  const ann = siteSettings.announcement;
  if (ann && ann.id) {
    try { localStorage.setItem(LS_ANNOUNCEMENT, ann.id); } catch (e) {}
  }
  document.getElementById("announcementBanner").classList.add("hidden");
}

export function openMaintenanceModal(currentUser) {
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

export function closeMaintenanceModal() {
  document.getElementById("maintenanceBackdrop").classList.remove("open");
  document.body.style.overflow = "";
}

export async function saveMaintenanceSettings(currentUser) {
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

export async function toggleMaintenance(currentUser) {
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

export function renderAdminMaintenance() {
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