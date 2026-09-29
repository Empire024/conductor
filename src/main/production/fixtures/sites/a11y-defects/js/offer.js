// A modal dialog with a defect: it moves focus in when it opens but never keeps it there.
(function () {
  const dialog = document.getElementById('offer')
  const opener = document.getElementById('open-offer')
  const close = document.getElementById('close-offer')
  if (!dialog || !opener || !close) return
  opener.addEventListener('click', () => { dialog.hidden = false; document.getElementById('take-offer').focus() })
  close.addEventListener('click', () => { dialog.hidden = true; opener.focus() })
})()
