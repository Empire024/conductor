// Fixture CMP: real buttons for both choices; the choice hides the banner and persists in a cookie.
(function () {
  const banner = document.getElementById('cookie-banner')
  const read = () => (document.cookie.match(/(?:^|; )consent=([^;]*)/) || [])[1] || null
  const store = value => { document.cookie = 'consent=' + value + '; path=/; max-age=31536000; samesite=lax' }
  if (read() === null && banner) banner.hidden = false
  document.addEventListener('click', event => {
    const control = event.target.closest('[data-consent-action]')
    if (!control || !banner) return
    const action = control.getAttribute('data-consent-action')
    if (action === 'accept') store('necessary,analytics')
    if (action === 'reject') store('necessary')
    banner.hidden = true
  })
})()
