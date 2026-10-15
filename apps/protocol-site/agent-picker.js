function copyText(text) {
  if (navigator.clipboard && document.hasFocus()) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) return Promise.reject(new Error("copy failed"));
  return Promise.resolve();
}

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-copy]") : null;
  if (!(button instanceof HTMLButtonElement)) return;
  const text = button.getAttribute("data-copy");
  if (!text) return;
  const label = button.textContent;
  copyText(text).then(() => {
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = label; }, 1600);
  }).catch(() => {
    button.textContent = "Select the text";
    window.setTimeout(() => { button.textContent = label; }, 1600);
  });
});
