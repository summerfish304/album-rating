import { db, collection, query, where, getDocs, getDoc, setDoc, doc, deleteDoc, serverTimestamp } from './firebase.js';
import { escapeHtml } from './utils.js';
import { showToast } from './ui.js';

let wishlistItems = [];

export async function loadWishlist(currentUser) {
  if (!currentUser) return;
  try {
    const q = query(collection(db, "wishlist"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    wishlistItems = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    wishlistItems.sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
  } catch (e) { wishlistItems = []; }
}

export function updateWishlistBadge() {
  const n = wishlistItems.length;
  const badge = document.getElementById("wishlistBadge");
  const mbadge = document.getElementById("mnavWishlistBadge");
  if (n > 0) {
    if (badge) { badge.textContent = n; badge.classList.remove("hidden"); }
    if (mbadge) { mbadge.textContent = n; mbadge.classList.remove("hidden"); }
  } else {
    if (badge) badge.classList.add("hidden");
    if (mbadge) mbadge.classList.add("hidden");
  }
}

export async function addToWishlist(currentUser, currentAlbum) {
  if (!currentUser) { showToast("Нужно войти"); return; }
  if (!currentAlbum) return;
  try {
    const docId = currentUser.uid + "_" + currentAlbum.source + "_" + currentAlbum.id;
    const snap = await getDoc(doc(db, "wishlist", docId));
    if (snap.exists()) { showToast("Уже в списке «Оценю позже»"); return; }
    await setDoc(doc(db, "wishlist", docId), {
      uid: currentUser.uid, releaseId: String(currentAlbum.id), source: currentAlbum.source,
      album: { id: currentAlbum.id, title: currentAlbum.title, artist: currentAlbum.artist, artwork: currentAlbum.artwork, source: currentAlbum.source },
      ts: serverTimestamp()
    });
    await loadWishlist(currentUser);
    updateWishlistBadge();
    showToast("Добавлено в «Оценю позже»", { success: true });
  } catch (e) { showToast("Ошибка: " + e.message); }
}

export async function removeFromWishlistIfExists(currentUser, source, releaseId) {
  if (!currentUser) return;
  try {
    const docId = currentUser.uid + "_" + source + "_" + releaseId;
    const snap = await getDoc(doc(db, "wishlist", docId));
    if (snap.exists()) {
      await deleteDoc(doc(db, "wishlist", docId));
      await loadWishlist(currentUser);
      updateWishlistBadge();
    }
  } catch (e) {}
}

export async function removeFromWishlist(id, onDone) {
  try {
    await deleteDoc(doc(db, "wishlist", id));
    if (onDone) await onDone();
    updateWishlistBadge();
  } catch (e) {}
}

export function renderWishlist(onRate) {
  const listEl = document.getElementById("wishlistList");
  if (wishlistItems.length === 0) {
    listEl.innerHTML = '<div class="empty-msg">Список пуст.<br>Добавляйте релизы кнопкой «Оценю позже» при открытии.</div>';
    return;
  }
  listEl.innerHTML = "";
  wishlistItems.forEach(item => {
    const el = document.createElement("div");
    el.className = "wishlist-item";
    el.innerHTML = '<img src="' + escapeHtml(item.album.artwork || "") + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="info"><div class="title">' + escapeHtml(item.album.title) + '</div><div class="artist">' + escapeHtml(item.album.artist) + '</div></div>' +
      '<div class="actions"><button class="wl-rate-btn">Оценить</button>' +
      '<button class="btn-secondary wl-del-btn">Удалить</button></div>';
    el.querySelector(".wl-rate-btn").onclick = () => onRate(item.source, item.album.id);
    el.querySelector(".wl-del-btn").onclick = () => removeFromWishlist(item._id, () => onRate(null, null));
    listEl.appendChild(el);
  });
}

export function getRandomWishlistItem() {
  if (wishlistItems.length === 0) return null;
  return wishlistItems[Math.floor(Math.random() * wishlistItems.length)];
}