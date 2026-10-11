// ---------- TOASTS / LOADERS ----------
export function showToast(text, options) {
  options = options || {};
  const el = document.getElementById("toast");
  el.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = text;
  el.appendChild(span);
  if (options.undo) {
    const btn = document.createElement("button");
    btn.className = "undo-btn";
    btn.textContent = "Отменить";
    btn.onclick = () => { options.undo(); el.classList.remove("show"); };
    el.appendChild(btn);
  }
  el.classList.remove("gold", "success");
  if (options.gold) el.classList.add("gold");
  if (options.success) el.classList.add("success");
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), options.duration || 2500);
}
export function showFloatingLoader(show) {
  const el = document.getElementById("floatingLoader");
  if (show) el.classList.add("visible");
  else el.classList.remove("visible");
}
export function showWarning(text) {
  const el = document.getElementById("warningBox");
  if (!text) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = text;
  el.classList.remove("hidden");
}
export function hideWarning() {
  document.getElementById("warningBox").classList.add("hidden");
}

// ---------- SKELETONS ----------
export function renderSkeletonList(containerId, rows) {
  rows = rows || 5;
  const el = typeof containerId === "string" ? document.getElementById(containerId) : containerId;
  if (!el) return;
  let html = '<div class="skeleton-list">';
  for (let i = 0; i < rows; i++) {
    html += '<div class="skeleton-row" style="animation-delay:' + (i * 60) + 'ms">' +
      '<div class="sk-cover"></div>' +
      '<div class="sk-info"><div class="sk-line"></div><div class="sk-line short"></div></div>' +
      '<div class="sk-score"></div>' +
    '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}
export function renderSkeletonCards(containerId, cards) {
  cards = cards || 6;
  const el = typeof containerId === "string" ? document.getElementById(containerId) : containerId;
  if (!el) return;
  let html = '<div class="skeleton-grid">';
  for (let i = 0; i < cards; i++) {
    html += '<div class="skeleton-card" style="animation-delay:' + (i * 60) + 'ms"></div>';
  }
  html += '</div>';
  el.innerHTML = html;
}