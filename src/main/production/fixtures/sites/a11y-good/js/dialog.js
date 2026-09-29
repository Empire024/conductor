// A native modal dialog: showModal() makes the rest of the page inert, so focus stays inside until it closes.
(function () {
  const dialog = document.getElementById('delivery-dialog')
  const opener = document.getElementById('open-delivery')
  const close = document.getElementById('close-delivery')
  if (!dialog || !opener || !close) return
  opener.addEventListener('click', () => dialog.showModal())
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => opener.focus())
})()
