let _confirmResolve = null;

export function showConfirm(opts) {
  opts = opts || {};
  const backdrop = document.getElementById("confirmBackdrop");
  const icon = document.getElementById("confirmIcon");
  const title = document.getElementById("confirmTitle");
  const text = document.getElementById("confirmText");
  const okBtn = document.getElementById("confirmOkBtn");
  const cancelBtn = document.getElementById("confirmCancelBtn");
  icon.textContent = opts.icon || "⚠️";
  title.textContent = opts.title || "Подтвердите действие";
  text.textContent = opts.text || "Вы уверены?";
  okBtn.textContent = opts.okText || "Удалить";
  cancelBtn.textContent = opts.cancelText || "Отмена";
  okBtn.className = opts.okClass || "btn-danger";
  okBtn.onclick = () => closeConfirm(true);
  cancelBtn.onclick = () => closeConfirm(false);
  backdrop.classList.add("open");
  document.body.style.overflow = "hidden";
  return new Promise((resolve) => { _confirmResolve = resolve; });
}

export function closeConfirm(result) {
  const backdrop = document.getElementById("confirmBackdrop");
  backdrop.classList.remove("open");
  document.body.style.overflow = "";
  if (_confirmResolve) {
    _confirmResolve(result);
    _confirmResolve = null;
  }
}