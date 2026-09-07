export function updatePanel(el, pinned) {
  var wasOpen = el.classList.contains('is-open');
  var wasPinned = pinned;
  el.classList.add('is-loading');
}
