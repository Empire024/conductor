// Fixture CMP: the tracker loads only after analytics consent, and consent persists in a cookie.
(function () {
  const banner = document.getElementById('cookie-banner')
  const read = () => (document.cookie.match(/(?:^|; )consent=([^;]*)/) || [])[1] || null
  const store = value => { document.cookie = 'consent=' + value + '; path=/; max-age=31536000; samesite=lax'; localStorage.setItem('consent', value) }
  const track = () => { const img = new Image(); img.src = '{{alias:baseline}}/__collect?event=pageview&page=' + encodeURIComponent(location.pathname) }
  const apply = value => { if (banner) banner.hidden = true; if (value && value.split(',').includes('analytics')) track() }
  const current = read()
  if (current !== null) apply(current)
  else if (banner) banner.hidden = false
  document.addEventListener('click', event => {
    const control = event.target.closest('[data-consent-action]')
    if (!control) return
    const action = control.getAttribute('data-consent-action')
    if (action === 'accept') { store('necessary,analytics,marketing'); apply('necessary,analytics,marketing') }
    if (action === 'reject') { store('necessary'); apply('necessary') }
    if (action === 'settings') document.getElementById('cookie-preferences').hidden = false
    if (action === 'save') {
      const chosen = [...document.querySelectorAll('[data-consent-category]')].filter(box => box.checked).map(box => box.getAttribute('data-consent-category'))
      store(chosen.join(',')); apply(chosen.join(','))
    }
    if (action === 'open' && banner) { banner.hidden = false }
  })
})()
