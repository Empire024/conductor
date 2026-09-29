// Fixture CMP (mode: before). The choice is stored in a first-party "cmp" cookie.
(function () {
  var MODE = 'before'
  var banner = document.getElementById('cookie-banner')
  var read = function () { return (document.cookie.match(/(?:^|; )cmp=([^;]*)/) || [])[1] || null }
  var store = function (value) { document.cookie = 'cmp=' + value + '; path=/; max-age=31536000; samesite=lax' }
  var load = function () {
    if (window.__trackerLoaded) return
    window.__trackerLoaded = true
    var script = document.createElement('script')
    script.src = '{{alias}}/js/analytics.js'
    document.head.appendChild(script)
  }
  var apply = function (value) {
    banner.hidden = true
    if (MODE === 'reject-tracks' || (value && value.split(',').indexOf('analytics') >= 0)) load()
  }
  if (MODE === 'before') load()
  var current = read()
  if (current !== null) apply(current)
  else banner.hidden = false
  document.addEventListener('click', function (event) {
    var control = event.target.closest('[data-consent-action]')
    if (!control) return
    var action = control.getAttribute('data-consent-action')
    if (action === 'accept') { store('necessary,functional,analytics'); apply('necessary,functional,analytics') }
    if (action === 'reject') { store('necessary'); apply('necessary') }
    if (action === 'settings') document.getElementById('cookie-preferences').hidden = false
    if (action === 'save') {
      var chosen = Array.prototype.slice.call(document.querySelectorAll('[data-consent-category]')).filter(function (box) { return box.checked }).map(function (box) { return box.getAttribute('data-consent-category') })
      store(chosen.join(',')); apply(chosen.join(','))
    }
    if (action === 'open') banner.hidden = false
  })
})()
